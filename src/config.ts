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

export function rtspPath(channel: number, stream: VideoStreamName, kind: "hevc" | "preview" | "h264"): string {
  const ch = String(channel + 1).padStart(2, "0");
  if (kind === "hevc") return `/h265Preview_${ch}_${stream}`;
  if (kind === "h264") return `/h264Preview_${ch}_${stream}`;
  return `/Preview_${ch}_${stream}`;
}

export function rtspCandidates(cam: CameraConfig): string[] {
  if (cam.rtspUrl) return [cam.rtspUrl];
  const user = encodeURIComponent(cam.username);
  const pass = encodeURIComponent(cam.password);
  const origin = `rtsp://${user}:${pass}@${cam.host}:${cam.rtspPort}`;
  const kinds: Array<"hevc" | "preview" | "h264"> =
    cam.sourceCodec === "h264" ? ["h264", "preview", "hevc"] : ["hevc", "preview", "h264"];
  return kinds.map((kind) => `${origin}${rtspPath(cam.channel, cam.videoStream, kind)}`);
}

export function defaultRtspUrl(cam: CameraConfig): string {
  return rtspCandidates(cam)[0];
}
