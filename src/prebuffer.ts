import type { CameraRecordingConfiguration } from "hap-nodejs";
import { AudioRecordingCodecType, AudioRecordingSamplerate, H264Level, H264Profile, VideoCodecType } from "hap-nodejs";
import type { AppConfig, CameraConfig } from "./config.js";
import type { AccelKind, FfmpegCaps } from "./ffmpeg.js";
import { ffmpegInputArgs, h264EncodeArgs, makeTranscodeOpts } from "./ffmpeg.js";
import { log } from "./logger.js";
import { Mp4StreamingServer } from "./mp4.js";

export interface RecordingFragment {
  init: boolean;
  data: Buffer;
}

type Listener = (frag: RecordingFragment) => void;

export class RecordingPrebuffer {
  private server?: Mp4StreamingServer;
  private loop?: Promise<void>;
  private init?: Buffer;
  private fragments: { t: number; data: Buffer }[] = [];
  private listeners = new Set<Listener>();
  private config?: CameraRecordingConfiguration;
  private prebufferMs = 4000;

  constructor(
    private readonly app: AppConfig,
    private readonly cam: CameraConfig,
    private readonly caps: FfmpegCaps,
    private readonly accel: AccelKind,
    _motion: () => boolean,
  ) {}

  async setConfiguration(configuration: CameraRecordingConfiguration | undefined): Promise<void> {
    this.config = configuration;
    this.prebufferMs = configuration?.mediaContainerConfiguration.fragmentLength ?? 4000;
    if (!configuration) {
      this.stop();
      return;
    }
    await this.restart();
  }

  stop(): void {
    this.server?.destroy();
    this.server = undefined;
    this.init = undefined;
    this.fragments = [];
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

  private async restart(): Promise<void> {
    this.stop();
    if (!this.config) return;
    const args = this.buildArgs(this.config);
    const server = new Mp4StreamingServer(this.app.ffmpegPath, args, this.app.verboseFfmpeg);
    this.server = server;
    await server.start();
    this.loop = this.consume(server);
  }

  private async consume(server: Mp4StreamingServer): Promise<void> {
    const pending: Buffer[] = [];
    try {
      for await (const box of server.generator()) {
        pending.push(box.header, box.data);
        if (box.type !== "moov" && box.type !== "mdat") continue;
        const fragment = Buffer.concat(pending);
        pending.length = 0;
        if (box.type === "moov") {
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
      if (!server.destroyed) {
        log.warn(`${this.cam.name}: recording encoder stopped: ${String(err)}`);
      }
    }
  }

  private buildArgs(configuration: CameraRecordingConfiguration): string[] {
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
      purpose: "record",
    });

    return [
      ...ffmpegInputArgs(opts),
      ...(audio.length ? audio : ["-an"]),
      "-sn",
      "-dn",
      ...h264EncodeArgs(opts),
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

