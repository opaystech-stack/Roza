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
# ==========================================

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

# ---- Stage 2: Runtime (production deps + compiled output only) ----
FROM node:20-slim
WORKDIR /app

ENV NODE_ENV=production
# Durable data directory (mount target for the SQLite volume). Matches the
# config.ts default and is read from the ROZA_DATA_DIR env var.
ENV ROZA_DATA_DIR=/app/data

# Install production dependencies. The build toolchain is needed to compile
# better-sqlite3's native bindings, then removed so it is not shipped.
COPY package*.json ./
RUN apt-get update && \
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

# Create the durable data directory (volume mount target for roza_mind.sqlite).
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Launch the single long-running Roza process.
CMD ["node", "dist/index.js"]
