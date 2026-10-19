import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type VideoStreamName = "main" | "sub" | "ext";
export type LiveCodec = "copy" | "transcode";
export type SourceCodec = "hevc" | "h264" | "auto";
export type HwAccel = "auto" | "nvidia" | "amd" | "intel" | "nvenc" | "vaapi" | "qsv" | "none";

export interface CameraConfig {
  name: string;
  host: string;
  /** Use HTTPS for the local Reolink API (login, snapshots, motion). */
  https: boolean;
  port: number;
  username: string;
  password: string;
  channel: number;
  rtspPort: number;
  videoStream: VideoStreamName;
  liveCodec: LiveCodec;
  sourceCodec: SourceCodec;
  audio: boolean;
  onvif: boolean;
  onvifPort?: number;
  rtspUrl?: string;
  snapshotUrl?: string;
}

export interface AppConfig {
  storageDir: string;
  ffmpegPath: string;
  verboseFfmpeg: boolean;
  motionPollMs: number;
  motionHoldMs: number;
  hwaccel: HwAccel;
  vaapiDevice: string;
  cameras: CameraConfig[];
}

const defaults = {
  https: false,
  port: 80,
  httpsPort: 443,
  channel: 0,
  rtspPort: 554,
  videoStream: "main" as VideoStreamName,
  liveCodec: "transcode" as LiveCodec,
  sourceCodec: "hevc" as SourceCodec,
  audio: true,
};

/**
 * Read `config.yaml` and fill in defaults for anything the file omits.
 *
 * @param path - path to the YAML config
 * @returns fully populated application config
 * @throws if `cameras` is missing or empty
 */
export function loadConfig(path: string): AppConfig {
  const raw = parse(readFileSync(path, "utf8")) as Partial<AppConfig> & {
    cameras?: Array<Partial<CameraConfig> & { name: string; host: string }>;
  };

  if (!raw.cameras?.length) {
    throw new Error("config.yaml must list at least one camera under `cameras`");
  }

  return {
    storageDir: raw.storageDir ?? "./data",
    ffmpegPath: raw.ffmpegPath ?? "ffmpeg",
    verboseFfmpeg: Boolean(raw.verboseFfmpeg),
    motionPollMs: raw.motionPollMs ?? 1500,
    motionHoldMs: raw.motionHoldMs ?? 20_000,
    hwaccel: raw.hwaccel ?? "auto",
    vaapiDevice: raw.vaapiDevice ?? "/dev/dri/renderD128",
    cameras: raw.cameras.map((cam) => {
      const https = cam.https ?? defaults.https;
      return {
        name: cam.name,
        host: cam.host,
        https,
        // HTTPS cameras default to 443; plain HTTP stays on 80 unless overridden.
        port: cam.port ?? (https ? defaults.httpsPort : defaults.port),
        username: cam.username ?? "admin",
        password: String(cam.password ?? ""),
        channel: cam.channel ?? defaults.channel,
        rtspPort: cam.rtspPort ?? defaults.rtspPort,
        videoStream: cam.videoStream ?? defaults.videoStream,
        liveCodec: cam.liveCodec ?? defaults.liveCodec,
        sourceCodec: cam.sourceCodec ?? defaults.sourceCodec,
        audio: cam.audio ?? defaults.audio,
        onvif: cam.onvif ?? true,
        onvifPort: cam.onvifPort,
        rtspUrl: cam.rtspUrl,
        snapshotUrl: cam.snapshotUrl,
      };
    }),
  };
}

/**
 * Reolink RTSP path for one channel and stream quality.
 * Channel numbers in the path are 1-based even though config channels are 0-based.
 *
 * @param channel - 0-based NVR channel
 * @param stream - main, sub, or ext
 * @param kind - HEVC preview, generic preview, or H.264 preview
 * @returns path beginning with `/`
 */
export function rtspPath(channel: number, stream: VideoStreamName, kind: "hevc" | "preview" | "h264"): string {
  const ch = String(channel + 1).padStart(2, "0");
  if (kind === "hevc") return `/h265Preview_${ch}_${stream}`;
  if (kind === "h264") return `/h264Preview_${ch}_${stream}`;
  return `/Preview_${ch}_${stream}`;
}

/**
 * RTSP URLs to try, in the order that matches the configured source codec.
 * An explicit `rtspUrl` replaces the generated list.
 *
 * @param cam - camera connection settings
 * @returns candidate URLs, most likely first
 */
export function rtspCandidates(cam: CameraConfig): string[] {
  if (cam.rtspUrl) return [cam.rtspUrl];
  const user = encodeURIComponent(cam.username);
  const pass = encodeURIComponent(cam.password);
  const origin = `rtsp://${user}:${pass}@${cam.host}:${cam.rtspPort}`;
  // Prefer the codec the user declared, then the other Reolink path shapes.
  const kinds: Array<"hevc" | "preview" | "h264"> =
    cam.sourceCodec === "h264" ? ["h264", "preview", "hevc"] : ["hevc", "preview", "h264"];
  return kinds.map((kind) => `${origin}${rtspPath(cam.channel, cam.videoStream, kind)}`);
}

/**
 * The first RTSP candidate, used when a probe has not yet chosen a working URL.
 *
 * @param cam - camera connection settings
 * @returns a single RTSP URL
 */
export function defaultRtspUrl(cam: CameraConfig): string {
  return rtspCandidates(cam)[0];
}
