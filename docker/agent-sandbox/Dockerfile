FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    fd-find \
    findutils \
    git \
    gnupg \
    jq \
    make \
    openssh-client \
    patch \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    tar \
    unzip \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Enable corepack (pnpm / yarn) for target repositories that need package managers
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Pre-create the workspace root expected by the worker engine
RUN mkdir -p /vercel/sandbox/repos \
    && git config --system init.defaultBranch main

WORKDIR /vercel/sandbox

CMD ["sleep", "3600"]
