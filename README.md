# reolink-hksv

Standalone HomeKit IP camera accessories for Reolink cameras, including **HomeKit Secure Video**.

Reolink 4K models often speak **H.265 only**. HomeKit does not accept HEVC, so this process **decodes H.265 and transcodes to H.264**. It uses the GPU when one is present:

| GPU | Decode / encode |
| --- | --- |
| NVIDIA | NVDEC + NVENC |
| AMD | VAAPI |
| Intel | Quick Sync (QSV), otherwise VAAPI |
| none | CPU libx264 |

Each camera is a separate HomeKit accessory (not a bridge). Pair them one by one, with a HomePod or Apple TV as the hub.

## Run with Docker

Host networking is required so Apple devices can find the accessories over mDNS.

```bash
cp config.example.yaml config.yaml
# set host, username, password
```

**AMD or Intel** (exposes `/dev/dri`):

```bash
docker compose up --build -d
```

**NVIDIA** (needs [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)):

```bash
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up --build -d
```

```bash
docker compose logs -f
```

Startup logs show which GPU was selected (`NVIDIA NVDEC/NVENC`, `VAAPI (AMD/Intel)`, or `Intel Quick Sync`). Force a vendor with `hwaccel: nvidia`, `amd`, or `intel` in `config.yaml`.

The log prints a PIN and QR code per camera. In the Home app: **Add Accessory** → scan / enter the PIN → turn on **Camera Recording**.

## Camera settings

1. Letters-and-numbers-only password (symbols often break RTSP).
2. Enable RTSP and HTTP.
3. Leave the camera on H.265 if that is all it offers.
4. Prefer `videoStream: main`. Override `rtspUrl` if needed, e.g. `rtsp://user:pass@ip:554/h265Preview_01_main`.

## Config

| Field | Meaning |
| --- | --- |
| `hwaccel` | `auto` (default), `nvidia`, `amd`, `intel`, or `none` |
| `vaapiDevice` | Render node for AMD/Intel, default `/dev/dri/renderD128` |
| `sourceCodec` | `hevc` (default), `h264`, or `auto` |
| `liveCodec` | `transcode` (default) or `copy` (H.264 only) |
| `videoStream` | `main` (default), `sub`, or `ext` |
| `onvif` | Discover the RTSP URL via ONVIF GetStreamUri (default `true`) |
| `onvifPort` | ONVIF port (Reolink is usually `8000`; other ports are tried automatically) |
| `rtspUrl` | Skip ONVIF and use this RTSP URL |

Pairing identity lives in `data/identities.json` and `data/hap`. Do not delete those unless you intend to re-pair.

## Without Docker

Needs Node.js 20+ and ffmpeg with HEVC decode plus one of `h264_nvenc`, `h264_vaapi`, `h264_qsv`, or `libx264`. Jellyfin’s ffmpeg build is a good choice on Linux.

```bash
npm install
npx tsx src/index.ts probe --host 192.168.1.80 --password YOURPASS
npx tsx src/index.ts start
```

## How it works

1. Local Reolink HTTP API for login, snapshots, and motion/AI state.
2. ONVIF `GetStreamUri` for the RTSP URL (then ffmpeg pulls that stream).
3. GPU (or CPU) HEVC → H.264 for live SRTP and HKSV fMP4.
4. Motion characteristic so the Apple hub starts a Secure Video clip.
