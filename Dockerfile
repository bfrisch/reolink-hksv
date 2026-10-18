FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/bfrisch/reolink-hksv" \
      org.opencontainers.image.description="Connect Reolink cameras to HomeKit Secure Video" \
      org.opencontainers.image.licenses="MIT"

# BuildKit sets TARGETARCH (amd64, arm64, arm). A Raspberry Pi 4 is linux/arm64
# (or armhf on 32-bit Raspberry Pi OS). intel-media-va-driver is amd64-only.
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
  && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && if [ "$arch" = "amd64" ]; then \
       apt-get install -y --no-install-recommends \
         mesa-va-drivers \
         intel-media-va-driver \
         vainfo; \
     elif [ "$arch" = "arm64" ] || [ "$arch" = "arm" ] || [ "$arch" = "armhf" ]; then \
       apt-get install -y --no-install-recommends \
         v4l-utils \
         libv4l-0; \
     fi \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" \
    > /etc/apt/sources.list.d/jellyfin.list \
  && apt-get update \
  && (apt-get install -y --no-install-recommends jellyfin-ffmpeg7 \
      || apt-get install -y --no-install-recommends jellyfin-ffmpeg6 \
      || apt-get install -y --no-install-recommends ffmpeg) \
  && if [ -x /usr/lib/jellyfin-ffmpeg/ffmpeg ]; then \
       ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg; \
       ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe; \
     fi \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json config.example.yaml ./
COPY src ./src

RUN mkdir -p /app/data

ENV NODE_ENV=production

VOLUME ["/app/data"]

CMD ["npx", "tsx", "src/index.ts", "start", "-c", "/app/config.yaml"]
