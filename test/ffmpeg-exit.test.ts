import assert from "node:assert/strict";
import { test } from "node:test";
import { ffmpegExitDetail } from "../src/ffmpeg.ts";
import { Mp4StreamingServer } from "../src/mp4.ts";

test("keeps the last ffmpeg stderr line for the exit log", () => {
  assert.equal(ffmpegExitDetail("banner\nError opening input file.\n"), ": Error opening input file.");
  assert.equal(ffmpegExitDetail(" \n\n"), "");
});

test("an ffmpeg exit fails the fMP4 reader and records the status", async () => {
  const server = new Mp4StreamingServer("false", [], false);
  try {
    await server.start();
    await assert.rejects(
      (async () => {
        for await (const box of server.generator()) {
          void box;
        }
      })(),
      /ffmpeg exited 1\//,
    );
    assert.equal(server.exited, true);
    assert.equal(server.exitCode, 1);
    assert.equal(server.destroyed, false);
  } finally {
    server.destroy();
  }
});

test("destroy unblocks a reader still waiting for ffmpeg to connect", async () => {
  const server = new Mp4StreamingServer("sh", ["-c", "sleep 10"], false);
  try {
    await server.start();
    const reading = (async () => {
      for await (const box of server.generator()) {
        void box;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.destroy();
    await assert.rejects(reading, /ffmpeg closed the fMP4 socket/);
  } finally {
    server.destroy();
  }
});
