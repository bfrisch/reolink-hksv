import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AppConfig, CameraConfig, HwAccel } from "./config.js";
import { defaultRtspUrl, rtspCandidates } from "./config.js";
import { log } from "./logger.js";

export type AccelKind = "nvenc" | "vaapi" | "qsv" | "cpu";

export interface FfmpegCaps {
  libx264: boolean;
  libopus: boolean;
  libfdkAac: boolean;
  hevc: boolean;
  h264Nvenc: boolean;
  hevcCuvid: boolean;
  h264Vaapi: boolean;
  hevcVaapi: boolean;
  h264Qsv: boolean;
  hevcQsv: boolean;
}

export type StreamCodec = "hevc" | "h264" | "unknown";

export async function detectFfmpeg(ffmpegPath: string): Promise<FfmpegCaps> {
  const encoders = await run(ffmpegPath, ["-hide_banner", "-encoders"]);
  const decoders = await run(ffmpegPath, ["-hide_banner", "-decoders"]);
  if (!encoders && !decoders) {
    throw new Error(`Could not run ${ffmpegPath}. Install ffmpeg and ensure it is on PATH.`);
  }
  return {
    libx264: /\blibx264\b/.test(encoders),
    libopus: /\blibopus\b/.test(encoders),
    libfdkAac: /\blibfdk_aac\b/.test(encoders),
    hevc: /\bhevc\b/.test(decoders) || /\bh265\b/.test(decoders) || /\bhevc_cuvid\b/.test(decoders),
    h264Nvenc: /\bh264_nvenc\b/.test(encoders),
    hevcCuvid: /\bhevc_cuvid\b/.test(decoders),
    h264Vaapi: /\bh264_vaapi\b/.test(encoders),
    hevcVaapi: /\bhevc_vaapi\b/.test(decoders) || /\bhevc\b/.test(decoders),
    h264Qsv: /\bh264_qsv\b/.test(encoders),
    hevcQsv: /\bhevc_qsv\b/.test(decoders),
  };
}

export interface HostGpu {
  nvidia: boolean;
  amd: boolean;
  intel: boolean;
  renderNodes: string[];
}

const PCI_NVIDIA = "0x10de";
const PCI_AMD = "0x1002";
const PCI_INTEL = "0x8086";

export function detectHostGpu(): HostGpu {
  let nvidia =
    existsSync("/dev/nvidia0") ||
    existsSync("/dev/nvidiactl") ||
    Boolean(process.env.NVIDIA_VISIBLE_DEVICES && process.env.NVIDIA_VISIBLE_DEVICES !== "void");
  const renderNodes: string[] = [];
  let amd = false;
  let intel = false;
  try {
    for (const name of readdirSync("/sys/class/drm")) {
      if (!name.startsWith("renderD")) continue;
      const node = `/dev/dri/${name}`;
      if (existsSync(node)) renderNodes.push(node);
      try {
        const vendor = readFileSync(`/sys/class/drm/${name}/device/vendor`, "utf8").trim().toLowerCase();
        if (vendor === PCI_AMD) amd = true;
        if (vendor === PCI_INTEL) intel = true;
        if (vendor === PCI_NVIDIA) nvidia = true;
      } catch {
        // no vendor file
      }
    }
  } catch {
    // no DRM
  }
  return { nvidia, amd, intel, renderNodes };
}

export function selectAccel(caps: FfmpegCaps, preference: HwAccel, host = detectHostGpu()): AccelKind {
  const requested = normalizePreference(preference);
  const order: AccelKind[] = [];

  const push = (kind: AccelKind) => {
    if (!order.includes(kind)) order.push(kind);
  };

  if (requested === "cpu") {
    push("cpu");
  } else if (requested === "nvenc") {
    push("nvenc");
    push("cpu");
  } else if (requested === "vaapi") {
    push("vaapi");
    push("cpu");
  } else if (requested === "qsv") {
    push("qsv");
    push("vaapi");
    push("cpu");
  } else {
    // auto: match installed silicon first, then whatever ffmpeg can encode with
    if (host.nvidia) push("nvenc");
    if (host.intel) {
      push("qsv");
      push("vaapi");
    }
    if (host.amd) push("vaapi");
    push("nvenc");
    push("qsv");
    push("vaapi");
    push("cpu");
  }

  for (const kind of order) {
    if (kind === "nvenc" && caps.h264Nvenc && (requested === "nvenc" || host.nvidia || requested === "auto")) {
      if (requested === "auto" && !host.nvidia) continue;
      return "nvenc";
    }
    if (kind === "qsv" && caps.h264Qsv && (requested === "qsv" || host.intel || requested === "auto")) {
      if (requested === "auto" && !host.intel) continue;
      return "qsv";
    }
    if (kind === "vaapi" && caps.h264Vaapi) {
      if (requested === "auto" && !host.amd && !host.intel && !host.renderNodes.length) continue;
      return "vaapi";
    }
    if (kind === "cpu" && caps.libx264) return "cpu";
  }

  if (caps.h264Nvenc && host.nvidia) return "nvenc";
  if (caps.h264Qsv) return "qsv";
  if (caps.h264Vaapi && host.renderNodes.length) return "vaapi";
  if (caps.libx264) return "cpu";
  throw new Error("No H.264 encoder found (need h264_nvenc, h264_vaapi, h264_qsv, or libx264)");
}

function normalizePreference(preference: HwAccel): HwAccel | "auto" | "nvenc" | "vaapi" | "qsv" | "cpu" {
  if (preference === "nvidia") return "nvenc";
  if (preference === "amd") return "vaapi";
  if (preference === "intel") return "qsv";
  if (preference === "none") return "cpu";
  return preference;
}

export function accelLabel(kind: AccelKind): string {
  switch (kind) {
    case "nvenc":
      return "NVIDIA NVDEC/NVENC";
    case "vaapi":
      return "VAAPI (AMD/Intel)";
    case "qsv":
      return "Intel Quick Sync";
    default:
      return "CPU libx264";
  }
}

export function srtpParam(keyAndSalt: Buffer): string {
  return keyAndSalt.toString("base64");
}

/** Live needs low latency; Secure Video recording can spend more on quality. */
export type EncodePurpose = "live" | "record";

export interface TranscodeOpts {
  url: string;
  verbose: boolean;
  accel: AccelKind;
  caps: FfmpegCaps;
  sourceCodec: StreamCodec | "hevc" | "h264" | "auto";
  width: number;
  height: number;
  fps: number;
  bitRateKbps: number;
  profile?: string;
  level?: string;
  iframeSec?: number;
  vaapiDevice?: string;
  purpose?: EncodePurpose;
}

export function ffmpegInputArgs(opts: Pick<TranscodeOpts, "url" | "verbose" | "accel" | "caps" | "sourceCodec" | "vaapiDevice">): string[] {
  const hevc = opts.sourceCodec !== "h264";
  const args = [
    "-hide_banner",
    "-loglevel",
    opts.verbose ? "warning" : "error",
  ];

  if (opts.accel === "nvenc") {
    args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
    if (hevc && opts.caps.hevcCuvid) args.push("-c:v", "hevc_cuvid");
  } else if (opts.accel === "vaapi") {
    args.push(
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      opts.vaapiDevice ?? "/dev/dri/renderD128",
      "-hwaccel_output_format",
      "vaapi",
    );
  } else if (opts.accel === "qsv") {
    args.push(
      "-hwaccel",
      "qsv",
      "-hwaccel_output_format",
      "qsv",
      "-qsv_device",
      opts.vaapiDevice ?? "/dev/dri/renderD128",
    );
    if (hevc && opts.caps.hevcQsv) args.push("-c:v", "hevc_qsv");
  }

  args.push(
    "-rtsp_transport",
    "tcp",
    "-fflags",
    "+genpts+discardcorrupt+nobuffer",
    "-flags",
    "low_delay",
    "-probesize",
    "32M",
    "-analyzeduration",
    "10M",
    "-i",
    opts.url,
  );
  return args;
}

export function h264EncodeArgs(opts: TranscodeOpts): string[] {
  const w = even(opts.width);
  const h = even(opts.height);
  const gop = Math.max(1, Math.round(opts.fps * (opts.iframeSec ?? 2)));
  const profile = opts.profile ?? "high";
  const level = opts.level ?? "4.0";
  const record = opts.purpose === "record";
  // HomeKit bitrates are often tight for HEVC→H.264; give recording more headroom.
  const bitRateKbps = record ? Math.round(opts.bitRateKbps * 1.5) : opts.bitRateKbps;
  const bufsize = `${bitRateKbps * 4}k`;
  const maxrate = `${bitRateKbps}k`;

  if (opts.accel === "nvenc") {
    // p4/p5 + VBR/CQ beat the old p1/CBR path for detail while staying real-time on GPU.
    const args = [
      "-vf",
      `scale_cuda=${w}:${h}:interp_algo=lanczos`,
      "-codec:v",
      "h264_nvenc",
      "-preset",
      record ? "p5" : "p4",
      "-tune",
      record ? "hq" : "ll",
      "-rc",
      "vbr",
      "-cq",
      record ? "19" : "23",
      "-b:v",
      maxrate,
      "-maxrate",
      maxrate,
      "-bufsize",
      bufsize,
      "-spatial-aq",
      "1",
      "-temporal-aq",
      "1",
      "-profile:v",
      profile,
      "-level",
      level,
      "-g",
      String(gop),
      "-bf",
      "0",
      "-delay",
      "0",
    ];
    if (record) {
      args.push("-rc-lookahead", "20", "-multipass", "fullres");
    }
    return args;
  }

  if (opts.accel === "vaapi") {
    // CQP keeps more detail than the old hard CBR path (lower qp = higher quality).
    return [
      "-vf",
      `scale_vaapi=w=${w}:h=${h}:format=nv12`,
      "-codec:v",
      "h264_vaapi",
      "-rc_mode",
      "CQP",
      "-qp",
      record ? "20" : "24",
      "-bf",
      "0",
      "-g",
      String(gop),
      "-profile:v",
      profile === "high" ? "high" : profile === "main" ? "main" : "constrained_baseline",
    ];
  }

  if (opts.accel === "qsv") {
    return [
      "-vf",
      `scale_qsv=w=${w}:h=${h}`,
      "-codec:v",
      "h264_qsv",
      "-preset",
      record ? "medium" : "fast",
      "-global_quality",
      record ? "20" : "23",
      "-look_ahead",
      record ? "1" : "0",
      "-b:v",
      maxrate,
      "-maxrate",
      maxrate,
      "-bufsize",
      bufsize,
      "-g",
      String(gop),
      "-bf",
      "0",
      "-profile:v",
      profile,
    ];
  }

  // Constrained CRF: quality-first, capped by HomeKit's bitrate.
  const args = [
    "-codec:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    record ? "veryfast" : "superfast",
    "-tune",
    record ? "film" : "zerolatency",
    "-profile:v",
    profile,
    "-level:v",
    level,
    "-crf",
    record ? "18" : "21",
    "-maxrate",
    maxrate,
    "-bufsize",
    bufsize,
    "-r",
    String(opts.fps),
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    "-g",
    String(gop),
    "-bf",
    "0",
  ];
  if (opts.iframeSec) {
    args.push("-force_key_frames", `expr:gte(t,n_forced*${opts.iframeSec})`);
  }
  return args;
}

function even(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

export function makeTranscodeOpts(
  app: AppConfig,
  cam: CameraConfig,
  caps: FfmpegCaps,
  accel: AccelKind,
  extra: {
    width: number;
    height: number;
    fps: number;
    bitRateKbps: number;
    profile?: string;
    level?: string;
    iframeSec?: number;
    purpose?: EncodePurpose;
  },
): TranscodeOpts {
  return {
    url: defaultRtspUrl(cam),
    verbose: app.verboseFfmpeg,
    accel,
    caps,
    sourceCodec: cam.sourceCodec,
    vaapiDevice: app.vaapiDevice,
    ...extra,
    purpose: extra.purpose ?? (extra.iframeSec ? "record" : "live"),
  };
}

export async function probeStreamCodec(ffmpegPath: string, url: string): Promise<StreamCodec> {
  const out = await run(ffmpegPath, [
    "-hide_banner",
    "-rtsp_transport",
    "tcp",
    "-probesize",
    "32M",
    "-analyzeduration",
    "10M",
    "-i",
    url,
  ]);
  if (/\bVideo:\s*(hevc|h265)\b/i.test(out)) return "hevc";
  if (/\bVideo:\s*(h264|avc)\b/i.test(out)) return "h264";
  return "unknown";
}

export async function resolveRtspUrl(ffmpegPath: string, cam: CameraConfig): Promise<{ url: string; codec: StreamCodec }> {
  const manual = Boolean(cam.rtspUrl);
  if (!manual) {
    const { fetchOnvifRtsp } = await import("./onvif.js");
    const onvifUrl = await fetchOnvifRtsp(cam);
    if (onvifUrl) {
      const codec = await probeStreamCodec(ffmpegPath, onvifUrl);
      cam.rtspUrl = onvifUrl;
      log.info(`${cam.name}: using ONVIF RTSP ${sanitizeUrl(onvifUrl)} (${codec === "unknown" ? cam.sourceCodec : codec})`);
      return { url: onvifUrl, codec: codec === "unknown" ? (cam.sourceCodec === "h264" ? "h264" : "hevc") : codec };
    }
  }

  const candidates = rtspCandidates(cam);
  let lastCodec: StreamCodec = "unknown";
  for (const url of candidates) {
    const codec = await probeStreamCodec(ffmpegPath, url);
    lastCodec = codec;
    if (codec !== "unknown") {
      log.info(`${cam.name}: using ${sanitizeUrl(url)} (${codec})`);
      cam.rtspUrl = url;
      return { url, codec };
    }
  }
  const fallback = candidates[0];
  log.warn(`${cam.name}: could not probe RTSP; using ${sanitizeUrl(fallback)}`);
  cam.rtspUrl = fallback;
  return { url: fallback, codec: cam.sourceCodec === "auto" ? lastCodec : cam.sourceCodec };
}

export function sanitizeUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":****@");
}

async function run(bin: string, args: string[]): Promise<string> {
  const child = spawn(bin, args, { env: process.env });
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    out += d.toString();
  });
  await once(child, "close");
  return out;
}
