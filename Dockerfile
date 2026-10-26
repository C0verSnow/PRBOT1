# Design reference: vercel/next.js examples/with-docker (MIT), see docs/delivery.md.
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && node scripts/stage-desktop.mjs

FROM node:24.22.1-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /data /home/node/.codex && chown -R node:node /workspace /data /home/node/.codex
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
    CODEX_WORKSPACE=/workspace PRBOT_DATA_DIR=/data CODEX_HOME=/home/node/.codex
COPY --from=build --chown=node:node /app/.desktop/server ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
