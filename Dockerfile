# syntax=docker/dockerfile:1
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM ${BUILD_FROM}

# ---------- System dependencies ----------
RUN apk add --no-cache \
    nodejs \
    npm \
    ffmpeg

# ---------- App ----------
WORKDIR /app

# Dependencies first — separate layer for cache efficiency
COPY package.json package-lock.json ./
RUN npm ci

# Application source
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/

# ---------- Entrypoint ----------
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
