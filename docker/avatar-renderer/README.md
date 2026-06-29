# Avatar renderer sidecar — Roza Agent Phase 4 (Avatar Video & Live Streaming)

This directory builds the **external Avatar_Renderer sidecar** — the separate
process that performs the talking-head / lip-sync **ML inference**. It is wired
up as the `avatar-renderer` service in the repo-root `docker-compose.yml`.

Roza's Node `roza-agent` performs **no ML in-process** (Req 2.6). It
orchestrates this sidecar over an **HTTP/IPC render endpoint** behind a
swappable interface (`src/connectors/avatar/renderer.ts`). Swapping the engine
(MuseTalk, SadTalker, …) re-implements only that Node adapter and this image —
Roza's core stays unchanged. Isolating the renderer as a sidecar also lets it
run on a **different (GPU) host** than the Node container.

## What this image is

| Concern | Choice | License | Commercial use |
|---------|--------|---------|----------------|
| Animation engine **code** | **LivePortrait** | MIT | ✅ |
| Face-analysis dependency | **MediaPipe Face Landmarker** (or **OpenCV YuNet**) — substituted for InsightFace | Apache-2.0 / BSD-3-Clause | ✅ |
| Lip-sync / portrait **weights** | operator-provisioned **commercially-licensed** checkpoint (e.g. Apache-2.0/MIT) | Apache-2.0 / MIT | ✅ |

## ⚠️ The InsightFace / Wav2Lip non-commercial caveat (Req 3.1, 3.2, 3.5)

LivePortrait's **code** is MIT and gives the best real-time quality on a GPU,
**but its default pipeline depends on InsightFace face-analysis models released
under a NON-COMMERCIAL research license** — disqualifying for commercial use
**as shipped**. Likewise, **Wav2Lip pretrained checkpoints are distributed
non-commercially** ("contact for the commercial HD model").

Therefore this image selects LivePortrait's MIT code **only** in a configuration
where:

- the **InsightFace** dependency is **replaced** by a commercially-licensed
  face-analysis component (MediaPipe Face Landmarker, Apache-2.0; or OpenCV
  YuNet, BSD-3-Clause), and
- the lip-sync weights are a **commercially-licensed** checkpoint (operator-
  provisioned; never the Wav2Lip non-commercial checkpoint).

**Excluded by construction (never ship these in production):**

- ⛔ **InsightFace stock models** — non-commercial research license.
- ⛔ **Wav2Lip pretrained checkpoints** — non-commercial.
- ⛔ **Paid avatar SaaS** (HeyGen / Tavus / D-ID) — Req 4.1.

Per Req 3.5, a permissively-licensed engine whose **weights and face-analysis
are commercially licensed** is preferred over an engine whose code is permissive
but whose weights/dependencies are non-commercial. The commercially-licensed
weights are **mounted read-only at deploy time** (`./docker/avatar-renderer/
weights → /opt/avatar/weights:ro`) — never committed to the repo and never baked
into the image.

## 🖼️ Placeholder portrait: replace `assets/roza-avatar.png` before production

The committed `assets/roza-avatar.png` is a **placeholder** Avatar_Image (the
Phase 2 portrait). The renderer animates whatever portrait the Node service
sends it, which is read from the Roza_Profile and defaults to this placeholder.

> **Operator action required:** replace `assets/roza-avatar.png` with real,
> rights-cleared artwork **before any production appearance** (live call, Meet,
> or stream). The placeholder must never represent Roza publicly.

## Endpoint & secrets contract

- Exposes **only** the HTTP/IPC render endpoint (`AVATAR_RENDERER_PORT`, default
  `9009`): it accepts `{ portrait image, reply PCM audio, target
  Avatar_Video_Format }` and streams rendered video frames back. No other
  surface is published; on the internal compose network it is reachable as
  `http://avatar-renderer:9009` and is **not** published to the host.
- Reads **no committed secret value**. The `Meet_Credentials` and `Stream_Key`
  live only on the Node side; this renderer needs none of them. The `AVATAR_*`
  variables here are **non-secret** format/tuning values and filesystem paths.

### Environment variables (names only — no secret values)

| Variable | Meaning |
|----------|---------|
| `AVATAR_RENDERER_BIND` | In-container bind address for the render endpoint (default `0.0.0.0`). |
| `AVATAR_RENDERER_PORT` | Render-endpoint port (default `9009`). The Node side targets `AVATAR_RENDERER_ENDPOINT=http://avatar-renderer:9009`. |
| `AVATAR_ENGINE` | Engine label/selection (e.g. `liveportrait`, `musetalk`). |
| `AVATAR_WIDTH` / `AVATAR_HEIGHT` / `AVATAR_FPS` / `AVATAR_PIXEL_FORMAT` | The Avatar_Video_Format the sidecar must emit so frames match what the Virtual_Camera consumes. |
| `AVATAR_WEIGHTS_DIR` | Path to the mounted, commercially-licensed weights (default `/opt/avatar/weights`). **Not a secret.** |

## 🎥🎙️ Host-level virtual devices (provisioned OUTSIDE this image)

The avatar **presence** pipeline relies on host-level virtual devices that live
outside these containers and must be provisioned by the operator on the host:

- **Virtual_Camera** — the **`v4l2loopback`** kernel module (GPL-2.0). Load it
  on the host (`sudo modprobe v4l2loopback`) to expose a `/dev/video*` node that
  Roza feeds rendered frames into via GStreamer/ffmpeg (`AVATAR_CAMERA_DEVICE`).
- **Virtual_Microphone** — a **PipeWire** (or PulseAudio) **null sink** (MIT) on
  the host, exposing the reply audio as a microphone source
  (`AVATAR_MIC_DEVICE`).

These are kernel-module / null-sink endpoints — **deployment prerequisites**,
not services, and **not a hard runtime gate** (with `AVATAR_ENABLED=false`
nothing in the avatar path is constructed).

## 💻 CPU / GPU expectation (deployment constraint, Req 10.2 — not a hard gate)

Conversational-latency lip-sync generally wants a **GPU** on the renderer host.
This is a **documented deployment constraint, not a hard runtime requirement**:

- The default `Dockerfile` builds on a **CPU base**, so it runs on a plain
  CPU-only VPS — synthesis is slower and Roza falls back to **audio-only**
  delivery through the operative Voice_Channel (Req 9.2).
- For a **GPU host**, switch the `Dockerfile` base to a CUDA runtime image and
  attach the GPU in `docker-compose.yml` (NVIDIA Container Toolkit `gpus: all`
  or the `deploy.resources.reservations.devices` block — both shown commented in
  the `avatar-renderer` service).

## Build

```sh
# From the repo root (build context is the repo root):
docker compose build avatar-renderer
# or directly:
docker build -f docker/avatar-renderer/Dockerfile -t roza-avatar-renderer:latest .
```

The committed `Dockerfile` is a **buildable skeleton + build notes**: vendor the
LivePortrait engine code, the commercial face-analysis substitute, and a small
HTTP wrapper exposing the render endpoint into this build context (e.g.
`requirements.txt` + `server.py`), then enable the documented `CMD`. The repo
intentionally commits **no large ML payload and no weights**.

## Security notes

- This directory commits **no secret value** and **no model weights**. Weights
  are mounted read-only at deploy time; secrets stay on the Node side.
- The render endpoint is reachable **only** on the internal compose network.
- Keep `docker/avatar-renderer/weights/` out of version control (operator-
  supplied, possibly large, and licensed separately).
