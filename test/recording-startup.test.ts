import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseRecordingStartup, ffmpegInputArgs, type FfmpegCaps } from "../src/ffmpeg.ts";

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

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const input = {
  url: "rtsp://user:pass@192.168.1.80:554/h265Preview_01_main",
  verbose: false,
  accel: "cpu" as const,
  caps,
  sourceCodec: "hevc" as const,
};

test("recording startup uses a short RTSP probe", () => {
  const args = ffmpegInputArgs({ ...input, startup: "fast" });
  assert.equal(flag(args, "-analyzeduration"), "2000000");
  assert.equal(flag(args, "-probesize"), "4M");
  assert.equal(flag(args, "-max_delay"), "0");
  assert.equal(flag(args, "-fpsprobesize"), "0");
  assert.match(flag(args, "-fflags") ?? "", /flush_packets/);
});

test("live startup keeps the longer probe", () => {
  const args = ffmpegInputArgs(input);
  assert.equal(flag(args, "-analyzeduration"), "10M");
  assert.equal(flag(args, "-probesize"), "32M");
  assert.equal(flag(args, "-max_delay"), undefined);
});

test("a short probe that never produces media falls back to the stable probe", () => {
  assert.equal(chooseRecordingStartup("fast", false), "stable");
  assert.equal(chooseRecordingStartup("fast", true), "fast");
  assert.equal(chooseRecordingStartup("stable", false), "stable");
  assert.equal(chooseRecordingStartup("stable", true), "stable");
});
