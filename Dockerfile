FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/bfrisch/reolink-hksv" \
      org.opencontainers.image.description="Connect Reolink cameras to HomeKit Secure Video" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    mesa-va-drivers \
    intel-media-va-driver \
    vainfo \
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

ENV NODE_ENV=production \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

VOLUME ["/app/data"]

CMD ["npx", "tsx", "src/index.ts", "start", "-c", "/app/config.yaml"]
