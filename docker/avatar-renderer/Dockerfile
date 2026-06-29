# ==========================================
# docker/avatar-renderer/Dockerfile — Roza Agent (Phase 4)
# External Avatar_Renderer SIDECAR image (BUILD NOTES + buildable skeleton)
#
# This image is the SEPARATE renderer process referenced by docker-compose.yml's
# `avatar-renderer` service. It is the ONLY component that performs ML inference
# (talking-head / lip-sync synthesis) and the only one that benefits from a GPU.
# Roza's Node `roza-agent` runs NO ML in-process (Req 2.6): it orchestrates this
# sidecar over an HTTP/IPC render endpoint behind the swappable interface
# src/connectors/avatar/renderer.ts. Swapping the engine (MuseTalk, SadTalker,
# ...) re-implements only that Node adapter and this image — Roza's core is
# unchanged.
#
# -----------------------------------------------------------------------------
# Licensing posture (Req 3.1, 3.2, 3.5) — read docker/avatar-renderer/README.md
# -----------------------------------------------------------------------------
#   * Engine CODE      : LivePortrait — MIT (commercial-use OK).               ✅
#   * Face-analysis    : a COMMERCIALLY-LICENSED substitute for InsightFace —
#                        MediaPipe Face Landmarker (Apache-2.0) or
#                        OpenCV YuNet (BSD-3-Clause).                          ✅
#   * Lip-sync weights : an operator-provisioned, COMMERCIALLY-LICENSED
#                        checkpoint (e.g. Apache-2.0 / MIT weights), mounted at
#                        deploy time — NOT baked into this image.              ✅
#
#   EXCLUDED by construction (Req 3.2, 4.1):
#   * InsightFace stock models  — NON-COMMERCIAL research license.            ⛔
#   * Wav2Lip pretrained checkpoints — NON-COMMERCIAL ("contact for commercial
#     HD model").                                                             ⛔
#   * Paid avatar SaaS (HeyGen / Tavus / D-ID).                               ⛔
#
# -----------------------------------------------------------------------------
# Endpoint & secrets contract
# -----------------------------------------------------------------------------
#   * Exposes ONLY the HTTP/IPC render endpoint (AVATAR_RENDERER_PORT, default
#     9009): accepts { portrait image, reply PCM audio, target Avatar_Video_
#     Format } and streams rendered video frames back. No other surface.
#   * Reads NO committed secret value. The Node side holds the Meet_Credentials
#     / Stream_Key; this renderer needs none of them. AVATAR_* here are
#     non-secret tuning/format values and filesystem paths only.
#   * The commercially-licensed weights are MOUNTED read-only at AVATAR_WEIGHTS_
#     DIR (see compose `./docker/avatar-renderer/weights:/opt/avatar/weights`),
#     never committed to the repo or baked into the image.
#
# -----------------------------------------------------------------------------
# GPU is a DEPLOYMENT CONSTRAINT, not a hard runtime gate (Req 10.2)
# -----------------------------------------------------------------------------
# Conversational-latency lip-sync generally wants a GPU. This image builds on a
# plain CPU base so it runs on a CPU-only VPS (slower → Roza falls back to
# audio-only, Req 9.2). For GPU hosts, switch the base to a CUDA runtime image
# and attach the GPU in compose (see the avatar-renderer service notes). The
# host Virtual_Camera (v4l2loopback kernel module) and Virtual_Microphone
# (PipeWire null sink) are HOST-level prerequisites provisioned outside this
# image — see README.md.
# ==========================================

# CPU-only base by default. For a GPU host, swap to e.g.
#   FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
# and install the CUDA-enabled engine/runtime wheels.
FROM python:3.11-slim AS runtime
WORKDIR /opt/avatar

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # In-container render-endpoint bind + port (compose maps the Node-side
    # AVATAR_RENDERER_ENDPOINT to http://avatar-renderer:${AVATAR_RENDERER_PORT}).
    AVATAR_RENDERER_BIND=0.0.0.0 \
    AVATAR_RENDERER_PORT=9009 \
    # Operator-provisioned, commercially-licensed weights live here (mounted
    # read-only at deploy time — NOT committed, NOT a secret path).
    AVATAR_WEIGHTS_DIR=/opt/avatar/weights

# System libraries the engine + face-analysis + frame I/O need at runtime.
# (ffmpeg/libGL for image/video handling; build tools only if a wheel needs
# compiling — kept minimal and removable.)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates git ffmpeg libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# --- Engine + commercial face-analysis substitute (Req 3.1, 3.2, 3.5) --------
# Install the LivePortrait (MIT) engine CODE and a COMMERCIALLY-LICENSED
# face-analysis dependency in place of the non-commercial InsightFace stock
# models — MediaPipe Face Landmarker (Apache-2.0) or OpenCV YuNet
# (BSD-3-Clause). Pin versions in requirements.txt for reproducible builds.
#
# NOTE: this is the documented build recipe; an operator supplies the engine
# checkout / wheels + a small HTTP service exposing the render endpoint. The
# requirements.txt MUST NOT pull InsightFace stock models or Wav2Lip
# checkpoints (non-commercial). Example shape:
#
#   COPY docker/avatar-renderer/requirements.txt ./requirements.txt
#   RUN pip install --no-cache-dir -r requirements.txt
#   COPY docker/avatar-renderer/server.py ./server.py
#
# (Left as notes so the repo commits no large ML payload and no weights.)

# The commercially-licensed lip-sync/portrait checkpoint is MOUNTED here at
# deploy time (compose volume → /opt/avatar/weights:ro). Never baked in.
VOLUME ["/opt/avatar/weights"]

# Expose ONLY the HTTP/IPC render endpoint.
EXPOSE 9009

# Launch the render service exposing ONLY the render endpoint. Replace with the
# operator's entrypoint (e.g. `python server.py`) once the engine + a small
# HTTP wrapper are vendored into this build context.
#   CMD ["python", "server.py"]
CMD ["sh", "-c", "echo 'avatar-renderer: provide engine code + render endpoint server (see README.md)'; exit 1"]
