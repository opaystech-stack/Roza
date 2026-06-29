# ==========================================
# Dockerfile — Roza Agent (multi-stage)
#
# Isolated Node.js 20+ TypeScript (ESM) service. Compiles `src/` to `dist/`
# via `tsc -p tsconfig.build.json` and runs `node dist/index.js`.
#
# better-sqlite3 is a native module: the build toolchain (python3/make/g++)
# is required when its bindings are compiled, but is NOT shipped in the final
# runtime image. Req 1.2 (Node 20+ base with TypeScript build support),
# Req 1.6 (durable data under /app/data).
#
# Phase 3 (Voice & Telephony) bundles the CPU-only, MIT-licensed voice
# binaries and permissively-licensed models directly in the runtime image so
# the Phase 3 adapters can spawn them as local subprocesses with NO paid cloud
# voice/STT API (Req 2.2, 3.1, 3.2). The Asterisk SIP/RTP gateway is a
# SEPARATE container (see docker-compose.yml); only Piper (TTS) and
# whisper.cpp (STT) live inside this image.
#
# -----------------------------------------------------------------------------
# Phase 3 voice runtime layout (the contract the adapters + config rely on)
# -----------------------------------------------------------------------------
#   TTS — Piper (MIT engine + permissive voice model)
#     binary      : /opt/piper/piper                 -> exposed via PIPER_BIN + PATH
#     bundled libs : /opt/piper/*.so* + espeak-ng-data (on LD_LIBRARY_PATH)
#     voice models : /opt/piper/models/<model>.onnx (+ .onnx.json)
#                    default model "en_US-amy-medium" => config TTS_MODEL=en_US-amy-medium
#     => tts.piper.ts spawns `${PIPER_BIN} --model ${PIPER_MODEL_DIR}/${TTS_MODEL}.onnx --output_raw`
#
#   STT — whisper.cpp (MIT engine + MIT ggml model)
#     binary      : /opt/whisper/main                -> exposed via WHISPER_BIN
#     ggml models : /opt/whisper/models/<model>.bin
#                    default model "ggml-base.en"    => config STT_MODEL=ggml-base.en
#     => stt.whisper.ts spawns `${WHISPER_BIN} -m ${WHISPER_MODEL_DIR}/${STT_MODEL}.bin ...`
#
# Deployment constraint (Req 12.3): both engines are CPU-only here. A GPU is
# OPTIONAL and is treated as a tuning lever for latency (Req 12.4), NOT a hard
# runtime requirement — the image runs on a plain CPU-only VPS.
# ==========================================

# Pinned upstream artifact versions (override at build time with --build-arg).
ARG PIPER_VERSION=2023.11.14-2
ARG WHISPER_VERSION=v1.5.5
# Default Piper voice model (MIT/CC0/CC-BY family) — must match config TTS_MODEL.
ARG PIPER_VOICE=en_US-amy-medium
ARG PIPER_VOICE_LANG=en/en_US/amy/medium
# Default whisper.cpp ggml model (MIT) — must match config STT_MODEL.
ARG WHISPER_MODEL=ggml-base.en

# ---- Stage 1: Build (install all deps + compile TypeScript) ----
FROM node:20-slim AS builder
WORKDIR /app

# Build tools for native modules (better-sqlite3).
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install full dependency set (incl. devDeps for tsc) against the lockfile.
COPY package*.json ./
RUN npm ci

# Compile TypeScript -> dist/
COPY . .
RUN npm run build

# ---- Stage 2: Voice-builder (fetch Piper + compile whisper.cpp + models) ----
# Debian bookworm-slim matches node:20-slim's base so the compiled whisper.cpp
# binary and Piper's bundled shared libraries are ABI-compatible with the
# runtime stage. Nothing from this stage except the /opt/* artifacts ships.
FROM debian:bookworm-slim AS voice-builder
ARG PIPER_VERSION
ARG WHISPER_VERSION
ARG PIPER_VOICE
ARG PIPER_VOICE_LANG
ARG WHISPER_MODEL

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl tar git build-essential && \
    rm -rf /var/lib/apt/lists/*

# --- Piper (TTS) — MIT. Prebuilt CPU x86_64 release tarball (no compile). ---
# Extracts to ./piper/{piper, *.so*, espeak-ng-data}. Pinned release artifact
# from rhasspy/piper releases (Req 3.1: MIT engine; Req 2.2: self-hosted).
RUN mkdir -p /opt && \
    curl -fsSL -o /tmp/piper.tar.gz \
        "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" && \
    tar -xzf /tmp/piper.tar.gz -C /opt && \
    rm -f /tmp/piper.tar.gz && \
    mkdir -p /opt/piper/models

# Permissively-licensed Piper voice model (.onnx + .onnx.json) pinned from the
# rhasspy/piper-voices repository (Req 3.1/3.2: commercial-use-permissive
# weights — MIT/CC0/CC-BY; no non-commercial weights).
RUN curl -fsSL -o "/opt/piper/models/${PIPER_VOICE}.onnx" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/${PIPER_VOICE_LANG}/${PIPER_VOICE}.onnx?download=true" && \
    curl -fsSL -o "/opt/piper/models/${PIPER_VOICE}.onnx.json" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/${PIPER_VOICE_LANG}/${PIPER_VOICE}.onnx.json?download=true"

# --- whisper.cpp (STT) — MIT. Compile the CPU build from a pinned tag. ---
# `make` produces ./main in the repo root. (Req 3.1: MIT engine; Req 2.2:
# self-hosted within the container; Req 12.3: CPU-only build, no GPU flags.)
RUN git clone --depth 1 --branch "${WHISPER_VERSION}" \
        https://github.com/ggerganov/whisper.cpp.git /tmp/whisper && \
    make -C /tmp/whisper main && \
    mkdir -p /opt/whisper/models && \
    cp /tmp/whisper/main /opt/whisper/main && \
    chmod +x /opt/whisper/main

# MIT-licensed ggml model weights pinned from the whisper.cpp model repo
# (Req 3.1/3.2: commercial-use-permissive weights).
RUN curl -fsSL -o "/opt/whisper/models/${WHISPER_MODEL}.bin" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL}.bin?download=true" && \
    rm -rf /tmp/whisper

# ---- Stage 3: Runtime (production deps + compiled output + voice binaries) ----
FROM node:20-slim
WORKDIR /app

ENV NODE_ENV=production
# Durable data directory (mount target for the SQLite volume). Matches the
# config.ts default and is read from the ROZA_DATA_DIR env var.
ENV ROZA_DATA_DIR=/app/data

# Phase 3 voice binary + model locations. These env vars are the single source
# of truth the Piper/whisper.cpp adapters (tts.piper.ts / stt.whisper.ts) and
# the config defaults (TTS_MODEL=en_US-amy-medium, STT_MODEL=ggml-base.en) read
# so the spawned binary/model paths line up with what is bundled below.
ENV PIPER_BIN=/opt/piper/piper \
    PIPER_MODEL_DIR=/opt/piper/models \
    WHISPER_BIN=/opt/whisper/main \
    WHISPER_MODEL_DIR=/opt/whisper/models
# Piper ships its shared libraries (libpiper_phonemize, libonnxruntime, ...)
# alongside the binary; put them on the loader path and the binary on PATH.
ENV LD_LIBRARY_PATH=/opt/piper:${LD_LIBRARY_PATH} \
    PATH=/opt/piper:${PATH}

# Runtime libraries for the bundled voice binaries:
#   - libgomp1: OpenMP runtime required by the whisper.cpp CPU build
#   - ca-certificates: TLS roots (kept minimal; no build toolchain shipped)
# Then install production dependencies. The build toolchain is needed to
# compile better-sqlite3's native bindings, then removed so it is not shipped.
COPY package*.json ./
RUN apt-get update && \
    apt-get install -y --no-install-recommends libgomp1 ca-certificates && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    npm ci --omit=dev && \
    apt-get purge -y python3 make g++ && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

# Copy compiled JavaScript from the builder stage.
COPY --from=builder /app/dist ./dist

# Copy committed runtime assets (e.g. assets/roza-avatar.png referenced by the
# Roza_Profile). These are static files, not compiled, so they ship verbatim
# from the builder stage into the runtime image at /app/assets.
COPY --from=builder /app/assets ./assets

# Bundle the CPU-only voice engines + models from the voice-builder stage:
#   /opt/piper   -> Piper (MIT) binary, shared libs, espeak-ng-data, models/
#   /opt/whisper -> whisper.cpp (MIT) `main` binary + ggml models/
COPY --from=voice-builder /opt/piper /opt/piper
COPY --from=voice-builder /opt/whisper /opt/whisper

# Create the durable data directory (volume mount target for roza_mind.sqlite).
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Launch the single long-running Roza process (entrypoint unchanged).
CMD ["node", "dist/index.js"]
