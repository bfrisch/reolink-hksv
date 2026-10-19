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
import { ffmpegExitDetail, ffmpegInputArgs, h264EncodeArgs, makeTranscodeOpts, srtpParam } from "./ffmpeg.js";
import type { AccessoryIdentity } from "./identities.js";
import { log } from "./logger.js";
import { RecordingPrebuffer } from "./prebuffer.js";
import { type DevInfo, parseFirmwareRevision, ReolinkClient } from "./reolink.js";

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
  process?: ChildProcess;
  localVideoPort: number;
  localAudioPort: number;
  /** ffmpeg argv, kept so a crashed process can be started again. */
  args: string[];
  /** Set before kill so the exit handler does not schedule another spawn. */
  stopping: boolean;
  /** Delayed respawn after an unexpected exit. Cleared by stopLive. */
  restartTimer?: NodeJS.Timeout;
  /** Spawn failed (missing binary). Do not restart. */
  spawnFailed?: boolean;
  /** Tell HomeKit the live stream is up. Called at most once. */
  markStarted?: () => void;
  /** Tell HomeKit the live stream failed to start. Called at most once. */
  failStart?: (err: Error) => void;
};

const usedPorts = new Set<number>();

/**
 * Reserve a localhost RTP port that no other live session is using.
 *
 * @returns a port in the ephemeral range
 * @throws when every candidate is already reserved
 */
function allocPort(): number {
  for (let i = 15000; i < 65000; i++) {
    if (!usedPorts.has(i)) {
      usedPorts.add(i);
      return i;
    }
  }
  throw new Error("no RTP ports available");
}

/**
 * One Reolink camera advertised as a HomeKit Secure Video accessory.
 * Live view is SRTP from ffmpeg; recordings come from a prebuffered fMP4 encoder.
 */
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
  private recordingConfig?: CameraRecordingConfiguration;
  private pollTimer?: NodeJS.Timeout;

  /**
   * Build the HAP accessory, camera controller, and recording prebuffer.
   * The accessory UUID is derived from host, channel, and name so a restart keeps the same pairing.
   *
   * @param app - process settings, including ffmpeg and motion timing
   * @param cam - this camera's connection and stream settings
   * @param identity - stable username, PIN, and setup ID
   * @param caps - ffmpeg encoders available on this host
   * @param accel - H.264 encoder family selected at startup
   */
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
              // AAC-ELD needs libfdk_aac. Without it, offer AAC-LC so recording still negotiates.
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

  /**
   * Apply camera identity fields from Reolink `GetDevInfo` (e.g. firmware).
   *
   * @param info - device info returned by the camera
   */
  applyDeviceInfo(info: DevInfo): void {
    const service = this.accessory.getService(Service.AccessoryInformation)!;
    if (typeof info.firmVer !== "string" || info.firmVer.length === 0) return;
    const revision = parseFirmwareRevision(info.firmVer);
    if (!revision) {
      log.warn(`${this.cam.name}: could not parse firmVer ${JSON.stringify(info.firmVer)}`);
      return;
    }
    service.updateCharacteristic(Characteristic.FirmwareRevision, revision);
    log.info(`${this.cam.name}: firmware ${info.firmVer} → ${revision}`);
  }

  /**
   * Advertise the accessory on the LAN and start polling for motion.
   * The setup URI logged here is what the Home app scans.
   */
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

  /** Stop motion polling, the recording encoder, live ffmpeg processes, and the HAP advertisement. */
  async unpublish(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.prebuffer.stop();
    for (const sessionId of Object.keys(this.ongoing)) {
      this.stopLive(sessionId);
    }
    await this.accessory.unpublish();
  }

  /**
   * Return a JPEG snapshot. The requested size is logged on failure; the camera serves its own resolution.
   *
   * @param request - width and height HomeKit asked for
   * @param callback - receives the JPEG, or the error
   */
  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    void this.client
      .snapshot()
      .then((buf) => callback(undefined, buf))
      .catch((err: unknown) => {
        log.warn(`${this.cam.name}: snapshot failed (${request.width}x${request.height}): ${String(err)}`);
        callback(err as Error);
      });
  }

  /**
   * Reserve local RTP ports and remember the SRTP keys until HomeKit sends START.
   *
   * @param request - destination address, ports, and crypto from the hub
   * @param callback - local ports and SSRCs the hub should send RTCP to
   */
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

  /**
   * Start, ignore a mid-stream reconfigure, or stop the live ffmpeg process for this session.
   *
   * @param request - START, RECONFIGURE, or STOP
   * @param callback - invoked once the request has been accepted or has failed
   */
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

  /**
   * HomeKit turned Secure Video recording on or off.
   * The encoder is started only while recording is active.
   *
   * @param active - whether the hub wants a recording stream
   */
  updateRecordingActive(active: boolean): void {
    this.recordingActive = active;
    log.info(`${this.cam.name}: HomeKit Secure Video recording ${active ? "enabled" : "disabled"}`);
    this.applyRecordingConfiguration(active ? this.recordingConfig : undefined);
  }

  /**
   * Store the codec selection HomeKit negotiated.
   * The encoder is not restarted until recording is actually active.
   *
   * @param configuration - selected resolution and codecs, or undefined when cleared
   */
  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.recordingConfig = configuration;
    // HomeKit often writes the selected configuration before Active=1. Keep it so the
    // encoder can start as soon as recording is actually enabled.
    if (!this.recordingActive) return;
    this.applyRecordingConfiguration(configuration);
  }

  /**
   * Stream prebuffered fMP4 to HomeKit until motion has been idle or the hub aborts.
   * Media fragments are held back until the init segment has been sent.
   *
   * @param streamId - HAP recording stream id, used to abort this generator later
   * @param signal - aborted when the hub closes the stream
   * @returns packets, with `isLast` set once motion has been idle past `motionHoldMs`
   */
  async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    const abort = new AbortController();
    this.recordAbort.set(streamId, abort);
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort);

    try {
      const sub = this.prebuffer.subscribe();
      await this.prebuffer.ensureRunning();
      let sentInit = false;
      const idleAfter = this.app.motionHoldMs;

      for await (const frag of sub) {
        if (abort.signal.aborted) break;
        if (frag.init) {
          sentInit = true;
          yield { data: frag.data, isLast: false };
          continue;
        }
        // Fragments from before the init segment cannot be decoded on their own.
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

  /**
   * Abort an open recording generator. The prebuffer itself keeps running for the next event.
   *
   * @param streamId - HAP recording stream id
   * @param reason - optional HomeKit close reason, logged when verbose
   */
  closeRecordingStream(streamId: number, reason?: HDSProtocolSpecificErrorReason): void {
    this.recordAbort.get(streamId)?.abort();
    this.recordAbort.delete(streamId);
    if (reason !== undefined) {
      log.debug(this.app.verboseFfmpeg, `${this.cam.name}: recording stream ${streamId} closed (${reason})`);
    }
  }

  /**
   * Build the SRTP ffmpeg command for a prepared session and spawn it.
   * The HomeKit callback is answered from the first stderr line, or after 1.5s if ffmpeg stays quiet.
   *
   * @param request - resolution, payload types, and session id from START
   * @param callback - success once ffmpeg is up, or an error if the session is unknown or spawn fails
   */
  private startLive(request: Extract<StreamingRequest, { type: StreamRequestTypes.START }>, callback: StreamRequestCallback): void {
    const session = this.pending[request.sessionID];
    if (!session) {
      callback(new Error("unknown session"));
      return;
    }

    const video = request.video;
    const vSrtp = srtpParam(session.videoSRTP);
    const aSrtp = srtpParam(session.audioSRTP);
    // Copy only when the camera is already H.264. HEVC still has to be transcoded for HomeKit.
    const copyOk = this.cam.liveCodec === "copy" && this.cam.sourceCodec === "h264";
    const opts = makeTranscodeOpts(this.app, this.cam, this.caps, this.accel, {
      width: video.width,
      height: video.height,
      fps: video.fps,
      bitRateKbps: video.max_bit_rate,
    });
    const videoCodec = copyOk ? ["-codec:v", "copy"] : h264EncodeArgs(opts);

    const args = [
      // A copy does not need a hardware decoder; leave the frames in software.
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

    let started = false;
    /** Answer the START callback once. Later stderr or a timeout must not call it again. */
    const markStarted = () => {
      if (started) return;
      started = true;
      callback();
    };
    /** Answer the START callback with an error, unless success was already reported. */
    const failStart = (err: Error) => {
      if (started) return;
      started = true;
      callback(err);
    };

    this.ongoing[request.sessionID] = {
      localVideoPort: session.localVideoPort,
      localAudioPort: session.localAudioPort,
      args,
      stopping: false,
      markStarted,
      failStart,
    };
    delete this.pending[request.sessionID];
    this.spawnLive(request.sessionID);

    // HomeKit is waiting on this callback. Answer even if ffmpeg has not written stderr yet.
    setTimeout(markStarted, 1500);
  }

  /**
   * Spawn ffmpeg for an active live session.
   * If that process exits on its own, log the error and start it again.
   *
   * @param sessionId - HomeKit session whose argv is already stored
   */
  private spawnLive(sessionId: string): void {
    const session = this.ongoing[sessionId];
    if (!session || session.stopping) return;

    const child = spawn(this.app.ffmpegPath, session.args, { env: process.env });
    session.process = child;
    // Kept for the exit log. Verbose mode also writes this to stderr.
    let stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
      if (this.app.verboseFfmpeg) process.stderr.write(d);
      session.markStarted?.();
    });
    child.on("error", (err) => {
      session.spawnFailed = true;
      log.error(`${this.cam.name}: ffmpeg failed: ${err.message}`);
      session.failStart?.(err);
    });
    child.on("exit", (code, signal) => {
      const current = this.ongoing[sessionId];
      // A stopped session, a replaced child, or a failed spawn should not come back.
      if (!current || current.stopping || current.process !== child || current.spawnFailed) {
        if (!current?.spawnFailed) current?.failStart?.(new Error(`ffmpeg exited ${code}/${signal}`));
        return;
      }
      log.error(
        `${this.cam.name}: ffmpeg exited (${code}/${signal})${ffmpegExitDetail(stderrTail)}; restarting`,
      );
      current.restartTimer = setTimeout(() => {
        current.restartTimer = undefined;
        if (current.stopping || current.spawnFailed || this.ongoing[sessionId] !== current) return;
        this.spawnLive(sessionId);
      }, 1000);
    });
  }

  /**
   * End a live session and cancel any pending ffmpeg restart.
   *
   * @param sessionId - HomeKit session to tear down
   */
  private stopLive(sessionId: string): void {
    const session = this.ongoing[sessionId];
    if (!session) return;
    session.stopping = true;
    if (session.restartTimer) clearTimeout(session.restartTimer);
    usedPorts.delete(session.localVideoPort);
    usedPorts.delete(session.localAudioPort);
    const child = session.process;
    // A dead pid can be reused; only signal a process that is still running.
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    delete this.ongoing[sessionId];
  }

  /**
   * Poll the camera for motion and hold the sensor active for `motionHoldMs` after the last hit.
   * The recording encoder is started on the rising edge, before HomeKit is notified.
   */
  private startMotionPoll(): void {
    /** One poll. Errors are logged and the interval keeps going. */
    const tick = async () => {
      try {
        const active = await this.client.motionActive();
        if (active) this.lastMotionAt = Date.now();
        const held = Date.now() - this.lastMotionAt < this.app.motionHoldMs;
        const next = active || held;
        if (next && !this.motion) {
          // Claim the edge before awaiting so a second poll cannot publish motion first.
          this.motion = true;
          try {
            // Spawn ffmpeg before HomeKit is told, so the hub's recording open is not a cold start.
            await this.prebuffer.ensureRunning();
          } catch (err) {
            log.warn(`${this.cam.name}: recording stream launch failed: ${String(err)}`);
          }
          this.accessory.getService(Service.MotionSensor)?.updateCharacteristic(Characteristic.MotionDetected, true);
          log.info(`${this.cam.name}: motion detected`);
        } else if (!next && this.motion) {
          this.motion = false;
          this.accessory.getService(Service.MotionSensor)?.updateCharacteristic(Characteristic.MotionDetected, false);
          log.info(`${this.cam.name}: motion cleared`);
        }
      } catch (err) {
        log.warn(`${this.cam.name}: motion poll failed: ${String(err)}`);
      }
    };
    void tick();
    this.pollTimer = setInterval(() => void tick(), this.app.motionPollMs);
  }

  /**
   * Push a recording configuration into the prebuffer. Failures are logged, not thrown to HAP.
   *
   * @param configuration - selected codecs, or undefined to stop the encoder
   */
  private applyRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    void this.prebuffer.setConfiguration(configuration).catch((err: unknown) => {
      log.warn(`${this.cam.name}: recording encoder failed to start: ${String(err)}`);
    });
  }
}
