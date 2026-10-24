FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@9.15.9 --activate

# Install static Docker CLI binary (supports both x86_64 and OCI ARM64 / aarch64)
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) docker_arch="x86_64" ;; \
      aarch64|arm64) docker_arch="aarch64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-27.5.1.tgz" -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker; \
    rm -f /tmp/docker.tgz; \
    docker --version

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

ENV NITRO_PRESET=node-server
RUN pnpm --filter worker run build:ci

WORKDIR /app/apps/worker

EXPOSE 3000

CMD ["sh", "-c", "pnpm run db:migrate && pnpm run seed:auth-user && exec node .output/server/index.mjs"]
