import type { CameraRecordingConfiguration } from "hap-nodejs";
import { AudioRecordingCodecType, AudioRecordingSamplerate, H264Level, H264Profile, VideoCodecType } from "hap-nodejs";
import type { AppConfig, CameraConfig } from "./config.js";
import type { AccelKind, FfmpegCaps } from "./ffmpeg.js";
import { chooseRecordingStartup, ffmpegInputArgs, h264EncodeArgs, makeTranscodeOpts, type RecordingStartup } from "./ffmpeg.js";
import { log } from "./logger.js";
import { Mp4StreamingServer } from "./mp4.js";

export interface RecordingFragment {
  init: boolean;
  data: Buffer;
}

type Listener = (frag: RecordingFragment) => void;

export class RecordingPrebuffer {
  private server?: Mp4StreamingServer;
  private init?: Buffer;
  private fragments: { t: number; data: Buffer }[] = [];
  private listeners = new Set<Listener>();
  private config?: CameraRecordingConfiguration;
  private prebufferMs = 4000;
  /** Bumped on every shutdown so an in-flight encoder cannot restart itself. */
  private session = 0;
  private pipelineOpen = false;
  private preferFastStart = true;
  private stopped = false;
  private restartTimer?: NodeJS.Timeout;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: AppConfig,
    private readonly cam: CameraConfig,
    private readonly caps: FfmpegCaps,
    private readonly accel: AccelKind,
    private readonly motion: () => boolean,
  ) {}

  async setConfiguration(configuration: CameraRecordingConfiguration | undefined): Promise<void> {
    await this.enqueue(async () => {
      if (this.stopped) return;
      this.config = configuration;
      this.prebufferMs = configuration?.mediaContainerConfiguration.fragmentLength ?? 4000;
      if (!configuration) {
        this.shutdownPipeline();
        return;
      }
      await this.startPipeline();
    });
  }

  /**
   * Spawn the recording encoder when it is not already up.
   * A running encoder is left alone so the prebuffer is still available at the motion edge.
   */
  async ensureRunning(): Promise<void> {
    await this.enqueue(async () => {
      if (this.stopped || !this.config || this.isRunning()) return;
      await this.startPipeline();
    });
  }

  /** Terminal stop used when the accessory is unpublished. */
  stop(): void {
    this.stopped = true;
    this.config = undefined;
    this.shutdownPipeline();
  }

  private isRunning(): boolean {
    return this.pipelineOpen && Boolean(this.server && !this.server.destroyed);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private cancelRestart(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private shutdownPipeline(): void {
    this.session++;
    this.cancelRestart();
    this.pipelineOpen = false;
    this.server?.destroy();
    this.server = undefined;
    this.init = undefined;
    this.fragments = [];
  }

  private scheduleRestart(session: number): void {
    if (this.restartTimer || this.stopped) return;
    // Reconnect quickly while an event is in progress; back off otherwise so a dead URL cannot spin.
    const delay = this.motion() ? 250 : 1000;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (session !== this.session || !this.config || this.stopped) return;
      void this.ensureRunning().catch((err: unknown) => {
        log.warn(`${this.cam.name}: recording encoder failed to start: ${String(err)}`);
        this.scheduleRestart(this.session);
      });
    }, delay);
  }

  private async startPipeline(): Promise<void> {
    if (this.stopped || !this.config) return;
    this.shutdownPipeline();
    const session = this.session;
    const fast = this.preferFastStart;
    const startup: RecordingStartup = fast ? "fast" : "stable";
    const args = this.buildArgs(this.config, startup);
    const server = new Mp4StreamingServer(this.app.ffmpegPath, args, this.app.verboseFfmpeg);
    this.server = server;
    try {
      await server.start();
    } catch (err) {
      server.destroy();
      if (this.server === server) this.server = undefined;
      throw err;
    }
    if (session !== this.session || this.stopped) {
      server.destroy();
      if (this.server === server) this.server = undefined;
      return;
    }
    this.pipelineOpen = true;
    log.info(
      `${this.cam.name}: HKSV recording encoder started${fast ? " with a short RTSP probe" : ""}`,
    );
    void this.consume(server, startup, session);
  }

  subscribe(): AsyncGenerator<RecordingFragment> {
    const queue: RecordingFragment[] = [];
    let notify: (() => void) | undefined;
    const listener: Listener = (frag) => {
      queue.push(frag);
      notify?.();
    };
    if (this.init) queue.push({ init: true, data: this.init });
    for (const f of this.fragments) queue.push({ init: false, data: f.data });
    this.listeners.add(listener);

    const self = this;
    return (async function* () {
      try {
        while (true) {
          while (queue.length) yield queue.shift()!;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      } finally {
        self.listeners.delete(listener);
      }
    })();
  }

  private emit(frag: RecordingFragment): void {
    for (const listener of this.listeners) listener(frag);
  }

  private async consume(server: Mp4StreamingServer, startup: RecordingStartup, session: number): Promise<void> {
    const pending: Buffer[] = [];
    let gotInit = false;
    // empty_moov is written as soon as the demuxer finishes probing. If that never happens, abandon
    // the short probe instead of leaving the hub waiting on a silent encoder.
    const deadline =
      startup === "fast"
        ? setTimeout(() => {
            if (gotInit || session !== this.session || server.destroyed) return;
            this.preferFastStart = false;
            server.destroy();
          }, 6_000)
        : undefined;
    try {
      for await (const box of server.generator()) {
        if (session !== this.session) break;
        pending.push(box.header, box.data);
        if (box.type !== "moov" && box.type !== "mdat") continue;
        const fragment = Buffer.concat(pending);
        pending.length = 0;
        if (box.type === "moov") {
          gotInit = true;
          if (deadline) clearTimeout(deadline);
          this.init = fragment;
          this.emit({ init: true, data: fragment });
          continue;
        }
        const now = Date.now();
        this.fragments.push({ t: now, data: fragment });
        const cutoff = now - this.prebufferMs - 1000;
        this.fragments = this.fragments.filter((f) => f.t >= cutoff);
        this.emit({ init: false, data: fragment });
      }
    } catch (err) {
      if (!server.destroyed && session === this.session) {
        log.warn(`${this.cam.name}: recording encoder stopped: ${String(err)}`);
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      if (this.server === server) this.pipelineOpen = false;
    }

    if (session !== this.session || this.stopped || !this.config) return;

    const next = chooseRecordingStartup(startup, gotInit);
    const giveUpFast = next !== startup;
    this.preferFastStart = next === "fast";
    if (giveUpFast) {
      log.warn(`${this.cam.name}: recording stream produced no media with a short probe; retrying`);
      try {
        await this.enqueue(async () => {
          if (this.stopped || !this.config || this.isRunning()) return;
          await this.startPipeline();
        });
      } catch (err) {
        log.warn(`${this.cam.name}: recording encoder failed to start: ${String(err)}`);
        this.scheduleRestart(this.session);
      }
      return;
    }
    if (server.destroyed) return;
    this.scheduleRestart(session);
  }

  private buildArgs(configuration: CameraRecordingConfiguration, startup: RecordingStartup): string[] {
    if (configuration.videoCodec.type !== VideoCodecType.H264) {
      throw new Error("HomeKit Secure Video requested a non-H.264 codec");
    }

    const profile =
      configuration.videoCodec.parameters.profile === H264Profile.HIGH
        ? "high"
        : configuration.videoCodec.parameters.profile === H264Profile.MAIN
          ? "main"
          : "baseline";
    const level =
      configuration.videoCodec.parameters.level === H264Level.LEVEL4_0
        ? "4.0"
        : configuration.videoCodec.parameters.level === H264Level.LEVEL3_2
          ? "3.2"
          : "3.1";

    const [width, height, fps] = configuration.videoCodec.resolution;
    const iframeSec = Math.max(1, configuration.videoCodec.parameters.iFrameInterval / 1000);
    const audio = this.audioArgs(configuration);
    const opts = makeTranscodeOpts(this.app, this.cam, this.caps, this.accel, {
      width,
      height,
      fps,
      bitRateKbps: configuration.videoCodec.parameters.bitRate,
      profile,
      level,
      iframeSec,
    });

    return [
      ...ffmpegInputArgs({ ...opts, startup }),
      ...(audio.length ? audio : ["-an"]),
      "-sn",
      "-dn",
      ...h264EncodeArgs(opts),
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-f",
      "mp4",
      "-fflags",
      "+genpts",
      "-reset_timestamps",
      "1",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
    ];
  }

  private audioArgs(configuration: CameraRecordingConfiguration): string[] {
    if (!this.cam.audio) return [];

    let samplerate = "16";
    switch (configuration.audioCodec.samplerate) {
      case AudioRecordingSamplerate.KHZ_8:
        samplerate = "8";
        break;
      case AudioRecordingSamplerate.KHZ_16:
        samplerate = "16";
        break;
      case AudioRecordingSamplerate.KHZ_24:
        samplerate = "24";
        break;
      case AudioRecordingSamplerate.KHZ_32:
        samplerate = "32";
        break;
      case AudioRecordingSamplerate.KHZ_44_1:
        samplerate = "44.1";
        break;
      case AudioRecordingSamplerate.KHZ_48:
        samplerate = "48";
        break;
      default:
        samplerate = "16";
    }

    if (this.caps.libfdkAac) {
      const profile = configuration.audioCodec.type === AudioRecordingCodecType.AAC_LC ? "aac_low" : "aac_eld";
      return [
        "-codec:a",
        "libfdk_aac",
        "-profile:a",
        profile,
        "-ar",
        `${samplerate}k`,
        "-b:a",
        `${configuration.audioCodec.bitrate}k`,
        "-ac",
        String(configuration.audioCodec.audioChannels),
      ];
    }

    return [
      "-codec:a",
      "aac",
      "-ar",
      `${samplerate}k`,
      "-b:a",
      `${configuration.audioCodec.bitrate}k`,
      "-ac",
      String(configuration.audioCodec.audioChannels),
    ];
  }
}

