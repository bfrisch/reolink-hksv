#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { HAPStorage } from "hap-nodejs";
import qrcode from "qrcode-terminal";
import { ReolinkHomeKitCamera } from "./camera.js";
import { defaultRtspUrl, loadConfig, type CameraConfig } from "./config.js";
import { detectFfmpeg, detectHostGpu, resolveRtspUrl, sanitizeUrl, selectAccel, accelLabel } from "./ffmpeg.js";
import { identityFor } from "./identities.js";
import { log } from "./logger.js";
import { ReolinkClient } from "./reolink.js";

const here = dirname(fileURLToPath(import.meta.url));
const exampleConfig = resolve(here, "../config.example.yaml");

function cameraKey(cam: CameraConfig): string {
  return `${cam.host}:${cam.channel}:${cam.name}`;
}

async function start(configPath: string): Promise<void> {
  const config = loadConfig(resolve(configPath));
  mkdirSync(config.storageDir, { recursive: true });
  HAPStorage.setCustomStoragePath(resolve(config.storageDir, "hap"));

  const caps = await detectFfmpeg(config.ffmpegPath);
  const host = detectHostGpu();
  if (config.vaapiDevice === "/dev/dri/renderD128" && host.renderNodes[0]) {
    config.vaapiDevice = host.renderNodes[0];
  }
  const accel = selectAccel(caps, config.hwaccel, host);
  log.info(
    `ffmpeg: libx264=${caps.libx264} nvenc=${caps.h264Nvenc} vaapi=${caps.h264Vaapi} qsv=${caps.h264Qsv} hevc=${caps.hevc}`,
  );
  log.info(
    `GPU: nvidia=${host.nvidia} amd=${host.amd} intel=${host.intel} render=${host.renderNodes.join(",") || "none"}`,
  );
  log.info(`HEVC→H.264 using ${accelLabel(accel)} (hwaccel=${config.hwaccel})`);
  if (accel === "cpu" && !caps.libx264) {
    throw new Error("No H.264 encoder available");
  }
  if (accel === "cpu") {
    log.warn("No usable GPU encoder; falling back to CPU. 4K HEVC will be heavy.");
  }
  if (!caps.hevc && !caps.hevcCuvid && !caps.hevcQsv) {
    throw new Error("ffmpeg is missing an HEVC decoder; Reolink H.265 streams cannot be transcoded");
  }

  const cameras: ReolinkHomeKitCamera[] = [];
  for (const cam of config.cameras) {
    if (!/^[A-Za-z0-9]+$/.test(cam.password)) {
      log.warn(`${cam.name}: password contains non-alphanumeric characters; Reolink RTSP often fails`);
    }
    const identity = identityFor(config.storageDir, cameraKey(cam));
    const accessory = new ReolinkHomeKitCamera(config, cam, identity, caps, accel);
    try {
      await accessory.client.login();
      const info = await accessory.client.deviceInfo();
      accessory.applyDeviceInfo(info);
      log.info(`${cam.name}: logged in (${JSON.stringify(info)})`);
    } catch (err) {
      for (const published of cameras) {
        try {
          await published.unpublish();
        } catch {
          // ignore
        }
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${cam.name}: Reolink API connection failed: ${detail}`);
    }
    try {
      const stream = await resolveRtspUrl(config.ffmpegPath, cam);
      if (stream.codec === "hevc" || cam.sourceCodec === "hevc") {
        log.info(`${cam.name}: transcoding HEVC → H.264 (${accelLabel(accel)})`);
      }
    } catch (err) {
      log.warn(`${cam.name}: RTSP probe failed: ${String(err)}`);
    }
    await accessory.publish();
    qrcode.generate(accessory.accessory.setupURI(), { small: true });
    cameras.push(accessory);
  }

  const shutdown = async () => {
    log.info("shutting down");
    for (const cam of cameras) {
      try {
        await cam.unpublish();
      } catch {
        // ignore
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function probe(opts: {
  host: string;
  username: string;
  password: string;
  port?: string;
  https?: boolean;
  channel: string;
}): Promise<void> {
  const https = Boolean(opts.https);
  const cam: CameraConfig = {
    name: opts.host,
    host: opts.host,
    https,
    port: opts.port !== undefined ? Number(opts.port) : https ? 443 : 80,
    username: opts.username,
    password: opts.password,
    channel: Number(opts.channel),
    rtspPort: 554,
    videoStream: "main",
    liveCodec: "transcode",
    sourceCodec: "hevc",
    audio: true,
    onvif: true,
  };
  const client = new ReolinkClient(cam);
  await client.login();
  const info = await client.deviceInfo();
  const motion = await client.motionActive();
  const stream = await resolveRtspUrl("ffmpeg", cam);
  console.log("device:", info);
  console.log("motion:", motion);
  console.log("rtsp:", sanitizeUrl(stream.url), stream.codec);
  console.log("rtsp main hevc:", sanitizeUrl(defaultRtspUrl({ ...cam, videoStream: "main", rtspUrl: undefined })));
}

const program = new Command();
program.name("reolink-hksv").description("Connect Reolink cameras to HomeKit Secure Video");

program
  .command("init")
  .description("Write config.yaml from the example")
  .option("-c, --config <path>", "config path", "config.yaml")
  .action((opts: { config: string }) => {
    if (existsSync(opts.config)) {
      throw new Error(`${opts.config} already exists`);
    }
    copyFileSync(exampleConfig, opts.config);
    log.info(`wrote ${opts.config} — edit it, then run: npx tsx src/index.ts start`);
  });

program
  .command("start")
  .description("Advertise each camera as a HomeKit Secure Video accessory")
  .option("-c, --config <path>", "config path", "config.yaml")
  .action((opts: { config: string }) => start(opts.config));

program
  .command("probe")
  .description("Log in to a camera and print stream URLs")
  .requiredOption("--host <ip>")
  .option("--username <user>", "username", "admin")
  .requiredOption("--password <password>")
  .option("--https", "use HTTPS for the local Reolink API (default port 443)")
  .option("--port <port>", "API port (default 80, or 443 with --https)")
  .option("--channel <n>", "NVR channel (0-based)", "0")
  .action((opts) => probe(opts));

program.parseAsync().catch((err: unknown) => {
  log.error(String(err));
  process.exit(1);
});
