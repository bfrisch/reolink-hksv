import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { H264Level, H264Profile, VideoCodecType, type CameraRecordingConfiguration } from "hap-nodejs";
import type { AppConfig, CameraConfig } from "../src/config.ts";
import type { FfmpegCaps } from "../src/ffmpeg.ts";
import { RecordingPrebuffer } from "../src/prebuffer.ts";

const caps: FfmpegCaps = {
  libx264: true,
  libopus: false,
  libfdkAac: false,
  hevc: true,
  h264Nvenc: false,
  hevcCuvid: false,
  h264Vaapi: false,
  hevcVaapi: false,
  h264Qsv: false,
  hevcQsv: false,
};

/**
 * Encoder that accepts the fMP4 socket, closes it, then exits later.
 * That is the usual order: the socket close is observable before the child exit event.
 */
function ffmpegThatClosesBeforeExit(exitDelayMs: number): { bin: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "prebuffer-exit-"));
  const program = path.join(dir, "fake-ffmpeg.mjs");
  writeFileSync(
    program,
    `import net from "node:net";
const target = process.argv.at(-1) ?? "";
const port = Number(target.match(/:(\\d+)$/)?.[1]);
process.stderr.write("Error opening input file.\\n");
const socket = net.connect(port, "127.0.0.1", () => {
  socket.end();
  setTimeout(() => process.exit(1), ${exitDelayMs});
});
socket.on("error", () => process.exit(2));
`,
  );
  const bin = path.join(dir, "fake-ffmpeg");
  writeFileSync(bin, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

async function recordEncoderStop(exitDelayMs: number): Promise<string[]> {
  const { bin, dir } = ffmpegThatClosesBeforeExit(exitDelayMs);
  const cam: CameraConfig = {
    name: "porch",
    host: "192.168.1.80",
    https: false,
    port: 80,
    username: "admin",
    password: "secret",
    channel: 0,
    rtspPort: 554,
    videoStream: "main",
    liveCodec: "transcode",
    sourceCodec: "h264",
    audio: false,
    onvif: false,
  };
  const app: AppConfig = {
    storageDir: dir,
    ffmpegPath: bin,
    verboseFfmpeg: false,
    motionPollMs: 1500,
    motionHoldMs: 20_000,
    hwaccel: "none",
    vaapiDevice: "/dev/dri/renderD128",
    cameras: [cam],
  };
  const configuration = {
    prebufferLength: 4000,
    eventTriggerTypes: [],
    mediaContainerConfiguration: { fragmentLength: 4000 },
    videoCodec: {
      type: VideoCodecType.H264,
      parameters: {
        profile: H264Profile.HIGH,
        level: H264Level.LEVEL4_0,
        bitRate: 2000,
        iFrameInterval: 2000,
      },
      resolution: [1920, 1080, 15] as [number, number, number],
    },
    audioCodec: {
      type: 0,
      samplerate: 0,
      bitrate: 32,
      audioChannels: 1,
    },
  } as CameraRecordingConfiguration;

  const lines: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  const prebuffer = new RecordingPrebuffer(app, cam, caps, "cpu", () => false);
  const note = (msg?: unknown, ...rest: unknown[]) => {
    const line = [msg, ...rest].map(String).join(" ");
    lines.push(line);
    if (line.includes("ffmpeg exited") || line.includes("recording encoder stopped") || line.includes("short probe")) {
      prebuffer.stop();
    }
  };
  console.error = note;
  console.warn = note;

  try {
    await prebuffer.setConfiguration(configuration);
    const started = Date.now();
    while (!lines.some((line) => line.includes("ffmpeg exited") || line.includes("short probe"))) {
      if (Date.now() - started > 4_000) {
        throw new Error(`encoder stop was not logged\n${lines.join("\n")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The exit log and the short-probe warning are adjacent; let the second one land.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return lines;
  } finally {
    console.error = origError;
    console.warn = origWarn;
    prebuffer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("recording encoder stop", { concurrency: false }, () => {
  test("a crash that closes the fMP4 socket first is logged as an ffmpeg exit", async () => {
    const lines = await recordEncoderStop(300);
    assert.ok(
      lines.some((line) => line.includes("porch: ffmpeg exited (1/null): Error opening input file.; restarting")),
      lines.join("\n"),
    );
    assert.equal(
      lines.some((line) => line.includes("recording encoder stopped")),
      false,
      lines.join("\n"),
    );
    assert.equal(
      lines.some((line) => line.includes("produced no media with a short probe")),
      false,
      lines.join("\n"),
    );
  });

  test("a socket close while ffmpeg is still running stays a socket stop", async () => {
    // Longer than consume()'s one-second exit grace, so the stop is classified first.
    const lines = await recordEncoderStop(2_500);
    assert.equal(
      lines.some((line) => line.includes("ffmpeg exited")),
      false,
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) =>
        line.includes("recording encoder stopped: Error: ffmpeg socket closed while reading 8 bytes"),
      ),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) => line.includes("produced no media with a short probe")),
      lines.join("\n"),
    );
  });
});
