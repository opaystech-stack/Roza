# Asterisk configuration templates — Roza Agent Phase 3 (Voice & Telephony)

These files are **configuration templates, not runtime config**. They contain
**no committed secrets** — every credential, host, and port is a `${VAR}`
placeholder drawn from the environment and substituted at deploy time. They
configure the self-hosted, open-source `asterisk` service introduced by the
Phase 3 multi-service deployment (Req 6.1–6.4, 7.1), which Roza's Node
`roza-agent` controls over ARI and bridges audio with over External
Media / AudioSocket.

## Files

| File | Purpose |
|------|---------|
| `http.conf` | Enables Asterisk's embedded HTTP server that the **ARI** control plane rides on (bind address + port). |
| `ari.conf` | Enables **ARI** and defines the control-plane user the Node adapter authenticates as. Notes the Stasis **app name `roza`**. |
| `pjsip.conf` | Defines the UDP transport and a single **SIP trunk** (registration + auth + AOR + endpoint + identify) for inbound/outbound PSTN/SIP calls. |
| `extensions.conf` | Dialplan that routes inbound calls into the **`Stasis(roza)`** application, supports ARI-originated outbound, and wires the AudioSocket media bridge. |

## How `${VAR}` placeholders are rendered

The templates use shell-style `${VAR}` syntax so they can be rendered with
[`envsubst`](https://www.gnu.org/software/gettext/manual/html_node/envsubst-Invocation.html)
(from `gettext`) by a container entrypoint **before** Asterisk starts. Secrets
are injected from the environment (Dokploy secrets / compose `environment:` /
a local `.env`) — they are never baked into the image and never committed.

Example entrypoint step (illustrative):

```sh
# Render each template into Asterisk's live config dir, then start Asterisk.
for f in http ari pjsip extensions; do
  envsubst < "/templates/asterisk/$f.conf" > "/etc/asterisk/$f.conf"
done
exec asterisk -f
```

> Note: Asterisk's own config format has no variable-default syntax, so the
> rendering step (not the file) supplies any defaults. Keep the rendered
> `/etc/asterisk/*.conf` readable only inside the container; it holds the
> substituted secret values at runtime.

## Environment variables consumed by these templates

No secret values appear in this repo — only the names below. Secrets are
supplied at deploy time.

### SIP trunk (secrets — `pjsip.conf`)
| Variable | Meaning |
|----------|---------|
| `SIP_HOST` | Registrar / proxy host of the SIP trunk. |
| `SIP_PORT` | Trunk signalling port (e.g. `5060`). |
| `SIP_USER` | Trunk auth / registration username. |
| `SIP_PASSWORD` | Trunk auth secret. **Never logged or committed.** |
| `SIP_REALM` | Auth realm / domain advertised by the provider. |
| `SIP_LOCAL_PORT` | Local UDP port Asterisk binds (e.g. `5060`). |

### ARI control plane (`http.conf`, `ari.conf`)
| Variable | Meaning |
|----------|---------|
| `ARI_HTTP_BIND_ADDR` | Bind address for the ARI/HTTP server (e.g. `0.0.0.0` on the internal network). |
| `ARI_HTTP_PORT` | ARI/HTTP port the Node client connects to. Asterisk default `8088`. |
| `ARI_ALLOWED_ORIGINS` | CORS allowed origins for ARI. Restrict to the internal origin; never `*` in production. |
| `ARI_USERNAME` | ARI control-plane username the Node adapter authenticates as. |
| `ARI_PASSWORD` | ARI control-plane secret. **Never logged or committed.** |

### Media bridge (`extensions.conf`)
| Variable | Meaning |
|----------|---------|
| `AUDIOSOCKET_HOST` | Host of the roza-agent AudioSocket TCP server (the Node service name). |
| `AUDIOSOCKET_PORT` | Port of that AudioSocket server (e.g. `8090`). |

### ARI credential choice (documented)

The ARI control-plane user uses **dedicated** `ARI_USERNAME` / `ARI_PASSWORD`
placeholders kept **separate** from the SIP trunk credentials
(`SIP_USER` / `SIP_PASSWORD`). The two sit on different trust boundaries — the
ARI HTTP/WebSocket control plane versus the SIP trunk signalling/media plane —
so they can be rotated and scoped independently, matching the design's
control-plane / media-plane separation (Component V7). An operator who prefers
to reuse the SIP credentials can simply point `ARI_USERNAME`/`ARI_PASSWORD` at
the same secret source at deploy time; no template change is needed.

## What the Node adapter expects

`src/connectors/voice/telephony.asterisk.ts` (`node-ari-client`) expects:

- **ARI endpoint**: `http://<asterisk-service>:${ARI_HTTP_PORT}/ari` and the
  matching WebSocket, authenticating with `${ARI_USERNAME}` / `${ARI_PASSWORD}`.
- **Stasis application name**: **`roza`** — the app the dialplan dispatches into
  (`Stasis(roza)` in `extensions.conf`, `ROZA_STASIS_APP` global) and the name
  the adapter subscribes to. Keep this in sync with the app name passed to
  `node-ari-client`.
- **Media**: ARI **External Media** channels (created programmatically) as the
  primary path, or the `roza-audiosocket` dialplan context streaming raw PCM to
  `${AUDIOSOCKET_HOST}:${AUDIOSOCKET_PORT}`. Audio frames follow the PCM
  contract in `src/connectors/voice/audio.ts` (signed 16-bit LE mono,
  8 kHz / 16 kHz).

## Security notes

- These templates commit **no secret values** (Req 7.1, 7.4). Secrets live only
  in the environment and in the rendered, container-local config.
- Expose Asterisk only on the **internal** compose network plus the SIP/RTP
  ports the trunk genuinely needs; do not publish the ARI HTTP port externally.
- Swapping Asterisk for an embedded SIP/WebRTC client later only touches
  `telephony.asterisk.ts` behind the unchanged `TelephonyGateway` interface
  (Req 6.4) — these templates are the only Asterisk-specific surface.
