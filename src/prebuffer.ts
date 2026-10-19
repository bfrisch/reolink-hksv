import type { CameraRecordingConfiguration } from "hap-nodejs";
import { AudioRecordingCodecType, AudioRecordingSamplerate, H264Level, H264Profile, VideoCodecType } from "hap-nodejs";
import type { AppConfig, CameraConfig } from "./config.js";
import type { AccelKind, FfmpegCaps } from "./ffmpeg.js";
import { chooseRecordingStartup, ffmpegExitDetail, ffmpegInputArgs, h264EncodeArgs, makeTranscodeOpts, type RecordingStartup } from "./ffmpeg.js";
import { log } from "./logger.js";
import { Mp4StreamingServer } from "./mp4.js";

export interface RecordingFragment {
  init: boolean;
  data: Buffer;
}

type Listener = (frag: RecordingFragment) => void;

/**
 * Continuous fMP4 encoder that keeps a few seconds of media ready for HomeKit Secure Video.
 * HomeKit opens the recording stream after motion, so the prebuffer has to already be running.
 */
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

  /**
   * @param app - ffmpeg path and verbosity
   * @param cam - camera whose RTSP URL is encoded
   * @param caps - ffmpeg capabilities, including the AAC encoder
   * @param accel - H.264 encoder family
   * @param motion - whether motion is currently held; used to pick the restart delay
   */
  constructor(
    private readonly app: AppConfig,
    private readonly cam: CameraConfig,
    private readonly caps: FfmpegCaps,
    private readonly accel: AccelKind,
    private readonly motion: () => boolean,
  ) {}

  /**
   * Replace the HomeKit recording configuration and restart the encoder.
   * `undefined` stops the pipeline, which is how recording is turned off.
   *
   * @param configuration - selected codecs and fragment length, or undefined to stop
   */
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

  /**
   * Whether the current ffmpeg process is still the one this prebuffer owns.
   *
   * @returns true while the pipeline has been started and not destroyed
   */
  private isRunning(): boolean {
    return this.pipelineOpen && Boolean(this.server && !this.server.destroyed);
  }

  /**
   * Run pipeline mutations one at a time. A failed task does not block the next one.
   *
   * @param task - work that starts, stops, or replaces the encoder
   * @returns the task's promise, including its rejection
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Drop a pending restart so a shutdown cannot be undone by the timer. */
  private cancelRestart(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  /**
   * Destroy the current encoder and invalidate any consume loop still reading it.
   * Session is incremented first so that loop observes the mismatch and exits.
   */
  private shutdownPipeline(): void {
    this.session++;
    this.cancelRestart();
    this.pipelineOpen = false;
    this.server?.destroy();
    this.server = undefined;
    this.init = undefined;
    this.fragments = [];
  }

  /**
   * Restart the encoder after a delay. Motion uses a short delay; a dead URL backs off.
   *
   * @param session - session that requested the restart; ignored if a newer shutdown happened
   */
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

  /**
   * Replace any current encoder with a new ffmpeg process and start consuming its fMP4.
   * The consume loop is not awaited; its exit path schedules the next attempt.
   */
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
    // A newer shutdown won the race while ffmpeg was spawning.
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

  /**
   * Subscribe to init and media fragments, starting with whatever is already buffered.
   * The generator runs until the consumer stops iterating, which drops the listener.
   *
   * @returns fragments, init segment first when one has already been seen
   */
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

  /**
   * Fan one fragment out to every current subscriber.
   *
   * @param frag - init segment or media fragment
   */
  private emit(frag: RecordingFragment): void {
    for (const listener of this.listeners) listener(frag);
  }

  /**
   * Read fMP4 until the socket closes, then decide whether to retry or give up the short probe.
   *
   * @param server - ffmpeg process started for this session
   * @param startup - probe size that process was given
   * @param session - session id captured at start; a mismatch means we were replaced
   */
  private async consume(server: Mp4StreamingServer, startup: RecordingStartup, session: number): Promise<void> {
    const pending: Buffer[] = [];
    let gotInit = false;
    let consumeError: unknown;
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
        // Keep a little more than one fragment length so a late subscriber still gets a GOP.
        const cutoff = now - this.prebufferMs - 1000;
        this.fragments = this.fragments.filter((f) => f.t >= cutoff);
        this.emit({ init: false, data: fragment });
      }
    } catch (err) {
      consumeError = err;
    } finally {
      if (deadline) clearTimeout(deadline);
      if (this.server === server) this.pipelineOpen = false;
    }

    if (session !== this.session || this.stopped || !this.config) return;

    // ffmpeg closes the fMP4 socket before the child "exit" event is delivered, so a crash
    // still looks like a generic socket stop until the process is reaped.
    if (consumeError && !server.destroyed && !server.exited) {
      await server.waitForExit(1_000);
    }
    if (session !== this.session || this.stopped || !this.config) return;

    // A kill we requested sets destroyed. An exit without that is a crash and should restart.
    const unexpectedExit = server.exited && !server.destroyed;
    if (unexpectedExit) {
      log.error(
        `${this.cam.name}: ffmpeg exited (${server.exitCode}/${server.exitSignal})${ffmpegExitDetail(server.stderrTail)}; restarting`,
      );
    } else if (consumeError && !server.destroyed) {
      log.warn(`${this.cam.name}: recording encoder stopped: ${String(consumeError)}`);
    }

    const next = chooseRecordingStartup(startup, gotInit);
    const giveUpFast = next !== startup;
    this.preferFastStart = next === "fast";
    if (giveUpFast) {
      // The process already exited; the short-probe warning would describe the wrong cause.
      if (!unexpectedExit) {
        log.warn(`${this.cam.name}: recording stream produced no media with a short probe; retrying`);
      }
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

  /**
   * Build the ffmpeg command that writes fragmented MP4 to the local TCP server.
   * The output URL itself is appended by `Mp4StreamingServer`.
   *
   * @param configuration - codecs and bitrate HomeKit selected
   * @param startup - how long ffmpeg may probe the RTSP input
   * @returns ffmpeg arguments without the output URL
   */
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

  /**
   * AAC encode arguments for the recording configuration, or an empty list when audio is disabled.
   * libfdk_aac is preferred because it can produce AAC-ELD; the native encoder is the fallback.
   *
   * @param configuration - sample rate, bitrate, and channel count from HomeKit
   * @returns audio arguments, or `[]` when this camera has audio turned off
   */
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
