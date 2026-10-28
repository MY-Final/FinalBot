FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY .dockerignore ./
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run build

FROM debian:bookworm-slim AS runtime
ARG CODEX_VERSION=0.164.0
ARG DEBIAN_MIRROR=deb.debian.org
RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git nodejs npm \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist/finalbot /usr/local/bin/finalbot
COPY --from=build /app/apps/web/dist /app/web
RUN useradd --create-home --uid 10001 finalbot \
  && mkdir -p /data /workspaces \
  && chown -R finalbot:finalbot /data /workspaces
USER finalbot
ENV FINALBOT_HOST=0.0.0.0 \
    FINALBOT_PORT=8787 \
    FINALBOT_DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data", "/workspaces"]
ENTRYPOINT ["/usr/local/bin/finalbot"]
