import { type ChildProcess, spawn } from "node:child_process";
import {
  Accessory,
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  type CameraRecordingConfiguration,
  type CameraRecordingDelegate,
  type CameraStreamingDelegate,
  Categories,
  Characteristic,
  H264Level,
  H264Profile,
  type HDSProtocolSpecificErrorReason,
  MediaContainerType,
  type PrepareStreamCallback,
  type PrepareStreamRequest,
  type PrepareStreamResponse,
  type RecordingPacket,
  type SnapshotRequest,
  type SnapshotRequestCallback,
  Service,
  SRTPCryptoSuites,
  type StreamingRequest,
  type StreamRequestCallback,
  StreamRequestTypes,
  uuid,
  VideoCodecType,
} from "hap-nodejs";
import type { AppConfig, CameraConfig } from "./config.js";
import type { AccelKind, FfmpegCaps } from "./ffmpeg.js";
import { ffmpegInputArgs, h264EncodeArgs, makeTranscodeOpts, srtpParam } from "./ffmpeg.js";
import type { AccessoryIdentity } from "./identities.js";
import { log } from "./logger.js";
import { RecordingPrebuffer } from "./prebuffer.js";
import { ReolinkClient } from "./reolink.js";

type SessionInfo = {
  address: string;
  videoPort: number;
  audioPort: number;
  localVideoPort: number;
  localAudioPort: number;
  videoSRTP: Buffer;
  audioSRTP: Buffer;
  videoSSRC: number;
  audioSSRC: number;
  videoCryptoSuite: SRTPCryptoSuites;
  audioCryptoSuite: SRTPCryptoSuites;
};

type OngoingSession = {
  process: ChildProcess;
  localVideoPort: number;
  localAudioPort: number;
};

const usedPorts = new Set<number>();

function allocPort(): number {
  for (let i = 15000; i < 65000; i++) {
    if (!usedPorts.has(i)) {
      usedPorts.add(i);
      return i;
    }
  }
  throw new Error("no RTP ports available");
}

export class ReolinkHomeKitCamera implements CameraStreamingDelegate, CameraRecordingDelegate {
  readonly accessory: Accessory;
  readonly controller: CameraController;
  readonly client: ReolinkClient;
  private readonly prebuffer: RecordingPrebuffer;
  private readonly pending: Record<string, SessionInfo> = {};
  private readonly ongoing: Record<string, OngoingSession> = {};
  private readonly recordAbort = new Map<number, AbortController>();
  private motion = false;
  private lastMotionAt = 0;
  private recordingActive = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly app: AppConfig,
    private readonly cam: CameraConfig,
    private readonly identity: AccessoryIdentity,
    private readonly caps: FfmpegCaps,
    private readonly accel: AccelKind,
  ) {
    this.client = new ReolinkClient(cam);
    this.prebuffer = new RecordingPrebuffer(app, cam, caps, accel, () => this.motion);

    this.accessory = new Accessory(cam.name, uuid.generate(`reolink-hksv:${cam.host}:${cam.channel}:${cam.name}`));
    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, "Reolink")
      .setCharacteristic(Characteristic.Model, "HKSV Bridge")
      .setCharacteristic(Characteristic.SerialNumber, `${cam.host}:${cam.channel}`)
      .setCharacteristic(Characteristic.FirmwareRevision, "0.1.0");

    this.controller = new CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: {
            profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
          resolutions: [
            [1920, 1080, 30],
            [1280, 720, 30],
            [640, 360, 30],
            [480, 270, 30],
            [320, 240, 15],
            [320, 180, 30],
          ],
        },
        audio: {
          codecs: [
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: [AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24],
              audioChannels: 1,
            },
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: [AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24],
              audioChannels: 1,
            },
          ],
        },
      },
      recording: {
        options: {
          prebufferLength: 4000,
          overrideEventTriggerOptions: undefined,
          mediaContainerConfiguration: [
            {
              type: MediaContainerType.FRAGMENTED_MP4,
              fragmentLength: 4000,
            },
          ],
          video: {
            type: VideoCodecType.H264,
            parameters: {
              profiles: [H264Profile.MAIN, H264Profile.HIGH],
              levels: [H264Level.LEVEL3_2, H264Level.LEVEL4_0],
            },
            resolutions: [
              [1920, 1080, 30],
              [1280, 720, 30],
              [640, 360, 30],
              [320, 240, 15],
            ],
          },
          audio: {
            codecs: {
              type: this.caps.libfdkAac ? AudioRecordingCodecType.AAC_ELD : AudioRecordingCodecType.AAC_LC,
              audioChannels: 1,
              samplerate: AudioRecordingSamplerate.KHZ_16,
              bitrateMode: AudioBitrate.VARIABLE,
            },
          },
        },
        delegate: this,
      },
      sensors: {
        motion: true,
      },
    });

    this.accessory.configureController(this.controller);
  }

  async publish(): Promise<void> {
    await this.accessory.publish({
      username: this.identity.username,
      pincode: this.identity.pincode,
      category: Categories.IP_CAMERA,
      setupID: this.identity.setupID,
      bind: "0.0.0.0",
    });
    this.startMotionPoll();
    log.info(
      `${this.cam.name} advertised as a HomeKit camera. Pin ${this.identity.pincode}  setup URI ${this.accessory.setupURI()}`,
    );
  }

  async unpublish(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.prebuffer.stop();
    for (const session of Object.values(this.ongoing)) {
      session.process.kill("SIGKILL");
    }
    await this.accessory.unpublish();
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    void this.client
      .snapshot()
      .then((buf) => callback(undefined, buf))
      .catch((err: unknown) => {
        log.warn(`${this.cam.name}: snapshot failed (${request.width}x${request.height}): ${String(err)}`);
        callback(err as Error);
      });
  }

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const videoSSRC = CameraController.generateSynchronisationSource();
    const audioSSRC = CameraController.generateSynchronisationSource();
    const localVideoPort = allocPort();
    const localAudioPort = allocPort();

    this.pending[request.sessionID] = {
      address: request.targetAddress,
      videoPort: request.video.port,
      audioPort: request.audio.port,
      localVideoPort,
      localAudioPort,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      videoSSRC,
      audioSSRC,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
    };

    const response: PrepareStreamResponse = {
      video: {
        port: localVideoPort,
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: localAudioPort,
        ssrc: audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };
    callback(undefined, response);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startLive(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopLive(request.sessionID);
        callback();
        break;
    }
  }

  updateRecordingActive(active: boolean): void {
    this.recordingActive = active;
    log.info(`${this.cam.name}: HomeKit Secure Video recording ${active ? "enabled" : "disabled"}`);
    if (!active) this.prebuffer.stop();
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    void this.prebuffer.setConfiguration(this.recordingActive ? configuration : undefined);
  }

  async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    const abort = new AbortController();
    this.recordAbort.set(streamId, abort);
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);

    try {
      const sub = this.prebuffer.subscribe();
      let sentInit = false;
      const idleAfter = this.app.motionHoldMs;

      for await (const frag of sub) {
        if (abort.signal.aborted) break;
        if (frag.init) {
          sentInit = true;
          yield { data: frag.data, isLast: false };
          continue;
        }
        if (!sentInit) continue;
        const idle = !this.motion && Date.now() - this.lastMotionAt > idleAfter;
        yield { data: frag.data, isLast: idle };
        if (idle) break;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.recordAbort.delete(streamId);
    }
  }

  closeRecordingStream(streamId: number, reason?: HDSProtocolSpecificErrorReason): void {
    this.recordAbort.get(streamId)?.abort();
    this.recordAbort.delete(streamId);
    if (reason !== undefined) {
      log.debug(this.app.verboseFfmpeg, `${this.cam.name}: recording stream ${streamId} closed (${reason})`);
    }
  }

  private startLive(request: Extract<StreamingRequest, { type: StreamRequestTypes.START }>, callback: StreamRequestCallback): void {
    const session = this.pending[request.sessionID];
    if (!session) {
      callback(new Error("unknown session"));
      return;
    }

    const video = request.video;
    const vSrtp = srtpParam(session.videoSRTP);
    const aSrtp = srtpParam(session.audioSRTP);
    const copyOk = this.cam.liveCodec === "copy" && this.cam.sourceCodec === "h264";
    const opts = makeTranscodeOpts(this.app, this.cam, this.caps, this.accel, {
      width: video.width,
      height: video.height,
      fps: video.fps,
      bitRateKbps: video.max_bit_rate,
    });
    const videoCodec = copyOk ? ["-codec:v", "copy"] : h264EncodeArgs(opts);

    const args = [
      ...(copyOk
        ? ffmpegInputArgs({ ...opts, accel: "cpu" })
        : ffmpegInputArgs(opts)),
      "-an",
      "-sn",
      "-dn",
      ...videoCodec,
      "-payload_type",
      String(video.pt),
      "-ssrc",
      String(session.videoSSRC),
      "-f",
      "rtp",
      "-srtp_out_suite",
      "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params",
      vSrtp,
      `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&localrtcpport=${session.localVideoPort}&pkt_size=${video.mtu}`,
    ];

    if (this.cam.audio && this.caps.libopus) {
      args.push(
        "-vn",
        "-sn",
        "-dn",
        "-codec:a",
        "libopus",
        "-application",
        "lowdelay",
        "-flags",
        "+global_header",
        "-ar",
        "24k",
        "-ac",
        "1",
        "-b:a",
        "24k",
        "-payload_type",
        String(request.audio.pt),
        "-ssrc",
        String(session.audioSSRC),
        "-f",
        "rtp",
        "-srtp_out_suite",
        "AES_CM_128_HMAC_SHA1_80",
        "-srtp_out_params",
        aSrtp,
        `srtp://${session.address}:${session.audioPort}?rtcpport=${session.audioPort}&localrtcpport=${session.localAudioPort}&pkt_size=188`,
      );
    }

    if (this.app.verboseFfmpeg) {
      log.info(`${this.cam.name}: ffmpeg ${args.join(" ")}`);
    }

    const child = spawn(this.app.ffmpegPath, args, { env: process.env });
    let started = false;
    child.stderr?.on("data", (d: Buffer) => {
      if (this.app.verboseFfmpeg) process.stderr.write(d);
      if (!started) {
        started = true;
        callback();
      }
    });
    child.on("error", (err) => {
      log.error(`${this.cam.name}: ffmpeg failed: ${err.message}`);
      if (!started) callback(err);
    });
    child.on("exit", (code, signal) => {
      if (!started) callback(new Error(`ffmpeg exited ${code}/${signal}`));
      else if (code && code !== 255) this.controller.forceStopStreamingSession(request.sessionID);
    });

    this.ongoing[request.sessionID] = {
      process: child,
      localVideoPort: session.localVideoPort,
      localAudioPort: session.localAudioPort,
    };
    delete this.pending[request.sessionID];

    setTimeout(() => {
      if (!started) {
        started = true;
        callback();
      }
    }, 1500);
  }

  private stopLive(sessionId: string): void {
    const session = this.ongoing[sessionId];
    if (!session) return;
    usedPorts.delete(session.localVideoPort);
    usedPorts.delete(session.localAudioPort);
    session.process.kill("SIGKILL");
    delete this.ongoing[sessionId];
  }

  private startMotionPoll(): void {
    const tick = async () => {
      try {
        const active = await this.client.motionActive();
        if (active) this.lastMotionAt = Date.now();
        const held = Date.now() - this.lastMotionAt < this.app.motionHoldMs;
        const next = active || held;
        if (next !== this.motion) {
          this.motion = next;
          this.accessory
            .getService(Service.MotionSensor)
            ?.updateCharacteristic(Characteristic.MotionDetected, next);
          log.info(`${this.cam.name}: motion ${next ? "detected" : "cleared"}`);
        }
      } catch (err) {
        log.warn(`${this.cam.name}: motion poll failed: ${String(err)}`);
      }
    };
    void tick();
    this.pollTimer = setInterval(() => void tick(), this.app.motionPollMs);
  }
}
