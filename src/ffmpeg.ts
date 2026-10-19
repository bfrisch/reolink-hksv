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

/**
 * Probe ffmpeg for the encoders and decoders this bridge can use.
 *
 * @param ffmpegPath - ffmpeg binary, or a name on `PATH`
 * @returns capability flags derived from `-encoders` and `-decoders`
 * @throws when the binary cannot be executed
 */
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

/**
 * Detect NVIDIA, AMD, and Intel GPUs from device nodes and DRM sysfs.
 * A container can expose NVIDIA through `NVIDIA_VISIBLE_DEVICES` without a render node.
 *
 * @returns which vendors are present and the usable `/dev/dri/renderD*` paths
 */
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

/**
 * Pick an H.264 encoder that both ffmpeg and the machine can actually use.
 * An explicit preference is tried first, then CPU. `auto` follows the installed GPU.
 *
 * @param caps - encoders ffmpeg reported
 * @param preference - user setting from config
 * @param host - detected GPUs; probed again when omitted
 * @returns the encoder family to pass into the ffmpeg argument builders
 * @throws when no H.264 encoder is available
 */
export function selectAccel(caps: FfmpegCaps, preference: HwAccel, host = detectHostGpu()): AccelKind {
  const requested = normalizePreference(preference);
  const order: AccelKind[] = [];

  /** Add a candidate once, preserving the first time it was requested. */
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
      // Do not pick NVENC in auto mode just because the binary was built with it.
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

  // Last chance if the ordered walk skipped a usable encoder.
  if (caps.h264Nvenc && host.nvidia) return "nvenc";
  if (caps.h264Qsv) return "qsv";
  if (caps.h264Vaapi && host.renderNodes.length) return "vaapi";
  if (caps.libx264) return "cpu";
  throw new Error("No H.264 encoder found (need h264_nvenc, h264_vaapi, h264_qsv, or libx264)");
}

/**
 * Map config names (`nvidia`, `amd`, `intel`, `none`) onto encoder families.
 *
 * @param preference - value from `hwaccel` in config
 * @returns an encoder family, or the original value when it is already one
 */
function normalizePreference(preference: HwAccel): HwAccel | "auto" | "nvenc" | "vaapi" | "qsv" | "cpu" {
  if (preference === "nvidia") return "nvenc";
  if (preference === "amd") return "vaapi";
  if (preference === "intel") return "qsv";
  if (preference === "none") return "cpu";
  return preference;
}

/**
 * Short label for logs.
 *
 * @param kind - selected encoder family
 * @returns a human-readable accelerator name
 */
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

/**
 * Encode an SRTP key and salt the way ffmpeg's `-srtp_out_params` expects them.
 *
 * @param keyAndSalt - concatenated SRTP key and salt from HomeKit
 * @returns base64 parameter
 */
export function srtpParam(keyAndSalt: Buffer): string {
  return keyAndSalt.toString("base64");
}

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
}

/** How long ffmpeg may inspect the RTSP input before it emits frames. */
export type RecordingStartup = "fast" | "stable";

/**
 * Short probe for a recording encoder started at motion time.
 * The stable probe is the fallback when the short one never produces an init segment.
 *
 * @param previous - probe used by the encoder that just stopped
 * @param producedInitialization - whether that encoder emitted an fMP4 init segment
 * @returns the probe the next encoder should use
 */
export function chooseRecordingStartup(previous: RecordingStartup, producedInitialization: boolean): RecordingStartup {
  if (previous === "fast" && !producedInitialization) return "stable";
  return previous;
}

const INPUT_PROBE: Record<RecordingStartup, { probesize: string; analyzeduration: string }> = {
  // 2s / 4MB is enough for a Reolink GOP and much shorter than the 10s live probe.
  fast: { probesize: "4M", analyzeduration: "2000000" },
  stable: { probesize: "32M", analyzeduration: "10M" },
};

/**
 * ffmpeg arguments up to and including `-i`. Hardware decode is selected from the accelerator.
 *
 * @param opts - input URL, accelerator, codec, and optional recording startup
 * @returns argument list ending with the input URL
 */
export function ffmpegInputArgs(
  opts: Pick<TranscodeOpts, "url" | "verbose" | "accel" | "caps" | "sourceCodec" | "vaapiDevice"> & {
    startup?: RecordingStartup;
  },
): string[] {
  const hevc = opts.sourceCodec !== "h264";
  const startup = opts.startup ?? "stable";
  const probe = INPUT_PROBE[startup];
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
    startup === "fast" ? "+genpts+discardcorrupt+nobuffer+flush_packets" : "+genpts+discardcorrupt+nobuffer",
    "-flags",
    "low_delay",
  );
  if (startup === "fast") {
    // Don't hold decoded frames in the demuxer while the hub is waiting on the first fragment.
    args.push("-max_delay", "0", "-fpsprobesize", "0");
  }
  args.push("-probesize", probe.probesize, "-analyzeduration", probe.analyzeduration, "-i", opts.url);
  return args;
}

/**
 * H.264 encode arguments for the selected accelerator, scaled to HomeKit's requested size.
 * B-frames are disabled so fragments can start on the next keyframe.
 *
 * @param opts - resolution, bitrate, profile, and accelerator
 * @returns ffmpeg arguments for the video encoder only
 */
export function h264EncodeArgs(opts: TranscodeOpts): string[] {
  const w = even(opts.width);
  const h = even(opts.height);
  const gop = Math.max(1, Math.round(opts.fps * (opts.iframeSec ?? 2)));
  const profile = opts.profile ?? "high";
  const level = opts.level ?? "4.0";

  if (opts.accel === "nvenc") {
    return [
      "-vf",
      `scale_cuda=${w}:${h}:interp_algo=lanczos`,
      "-codec:v",
      "h264_nvenc",
      "-preset",
      "p1",
      "-tune",
      "ll",
      "-rc",
      "cbr",
      "-b:v",
      `${opts.bitRateKbps}k`,
      "-maxrate",
      `${opts.bitRateKbps}k`,
      "-bufsize",
      `${opts.bitRateKbps * 2}k`,
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
  }

  if (opts.accel === "vaapi") {
    return [
      "-vf",
      `scale_vaapi=w=${w}:h=${h}:format=nv12`,
      "-codec:v",
      "h264_vaapi",
      "-b:v",
      `${opts.bitRateKbps}k`,
      "-maxrate",
      `${opts.bitRateKbps}k`,
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
      "veryfast",
      "-b:v",
      `${opts.bitRateKbps}k`,
      "-maxrate",
      `${opts.bitRateKbps}k`,
      "-g",
      String(gop),
      "-bf",
      "0",
      "-profile:v",
      profile,
    ];
  }

  const args = [
    "-codec:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-profile:v",
    profile,
    "-level:v",
    level,
    "-b:v",
    `${opts.bitRateKbps}k`,
    "-maxrate",
    `${opts.bitRateKbps}k`,
    "-bufsize",
    `${opts.bitRateKbps * 2}k`,
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

/**
 * Round a dimension down to an even number. H.264 rejects odd widths and heights.
 *
 * @param n - pixel count from HomeKit
 * @returns `n`, or `n - 1` when `n` is odd
 */
function even(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

/**
 * Assemble transcode options from app config, the camera, and one HomeKit request.
 *
 * @param app - ffmpeg path, verbosity, and VAAPI device
 * @param cam - RTSP URL and source codec
 * @param caps - ffmpeg capabilities
 * @param accel - encoder family already selected for this process
 * @param extra - resolution, frame rate, bitrate, and optional GOP timing
 * @returns options for the input and encode argument builders
 */
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
  };
}

/**
 * Open an RTSP URL just long enough to read the video codec from ffmpeg's banner.
 *
 * @param ffmpegPath - ffmpeg binary
 * @param url - RTSP URL, including credentials
 * @returns `hevc`, `h264`, or `unknown` when the probe produced no video line
 */
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

/**
 * Choose a working RTSP URL and remember it on the camera config.
 * ONVIF is tried first unless the user set `rtspUrl`; generated Reolink paths are the fallback.
 *
 * @param ffmpegPath - ffmpeg binary used to probe each candidate
 * @param cam - camera settings; `rtspUrl` is written when a candidate is accepted
 * @returns the URL and the codec ffmpeg reported, or the configured codec when the probe is inconclusive
 */
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
  // Every probe failed. Keep the first candidate so a later retry still has a URL.
  const fallback = candidates[0];
  log.warn(`${cam.name}: could not probe RTSP; using ${sanitizeUrl(fallback)}`);
  cam.rtspUrl = fallback;
  return { url: fallback, codec: cam.sourceCodec === "auto" ? lastCodec : cam.sourceCodec };
}

/**
 * Replace the password in an RTSP URL so logs can include the path.
 *
 * @param url - URL that may contain userinfo
 * @returns the same URL with every password replaced by `****`
 */
export function sanitizeUrl(url: string): string {
  return url.replace(/:[^:@/]+@/g, ":****@");
}

/**
 * Last ffmpeg stderr line, for an exit log. Empty when ffmpeg wrote nothing.
 *
 * @param stderr - rolling stderr captured from the process
 * @returns a `: message` suffix, or `""` when there is nothing to show
 */
export function ffmpegExitDetail(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  // Connection errors include the input URL. Redact it before the always-on exit log.
  return line ? `: ${sanitizeUrl(line)}` : "";
}

/**
 * Run a command to completion and return combined stdout and stderr.
 * ffmpeg prints codec banners on stderr, so both streams are kept.
 *
 * @param bin - executable
 * @param args - arguments
 * @returns everything the process wrote
 */
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
