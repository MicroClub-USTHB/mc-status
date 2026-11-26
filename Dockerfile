# mc-status as a container: the project's own standalone Linux build (assets
# embedded) on the Bun runtime image. targets.yaml is baked in (it holds no
# secrets), so changing a check means a new image.
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run validate && bun run build:linux

FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app
COPY --from=build --chown=bun:bun /app/build/linux-x64/ ./
# Outage history lives in SQLite: mount a volume on /data.
RUN mkdir -p /data && chown bun:bun /data
ENV DB_PATH=/data/mc-status.db
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["./mc-status"]
