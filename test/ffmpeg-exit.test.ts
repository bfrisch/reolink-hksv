import assert from "node:assert/strict";
import { test } from "node:test";
import { ffmpegExitDetail } from "../src/ffmpeg.ts";
import { Mp4StreamingServer } from "../src/mp4.ts";

test("keeps the last ffmpeg stderr line for the exit log", () => {
  assert.equal(ffmpegExitDetail("banner\nError opening input file.\n"), ": Error opening input file.");
  assert.equal(ffmpegExitDetail(" \n\n"), "");
});

test("redacts RTSP credentials in the exit log detail", () => {
  const stderr = [
    "ffmpeg version 6.1",
    "rtsp://admin:s3cret@192.168.1.80:554/h265Preview_01_main: Connection refused",
    "",
  ].join("\n");
  assert.equal(
    ffmpegExitDetail(stderr),
    ": rtsp://admin:****@192.168.1.80:554/h265Preview_01_main: Connection refused",
  );
  assert.equal(
    ffmpegExitDetail(
      "banner\nError opening input files: rtsp://user:s3cret@10.0.0.2:554/stream and rtsp://other:hunter2@10.0.0.3:554/sub\n",
    ),
    ": Error opening input files: rtsp://user:****@10.0.0.2:554/stream and rtsp://other:****@10.0.0.3:554/sub",
  );
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
