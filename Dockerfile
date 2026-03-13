ARG BUN_IMAGE=oven/bun
ARG BUN_TAG=latest

# -- Build stage: install deps and compile SvelteKit frontend --
FROM ${BUN_IMAGE}:${BUN_TAG} AS build

WORKDIR /app

# Copy root package.json and sub-package manifests for layer caching
COPY package.json ./
COPY server/package.json server/bun.lock server/
COPY web/package.json web/bun.lock web/

RUN bun run install

# Copy source
COPY common/ common/
COPY server/ server/
COPY web/ web/

# Build the SvelteKit frontend
RUN bun run build

# -- Runtime stage --
FROM ${BUN_IMAGE}:${BUN_TAG}

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV HOME=/home/garcon
ENV PATH="${HOME}/.bun/bin:${PATH}"
ENV PATH="${HOME}/.local/bin:${PATH}"

# Install Claude
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV CLAUDE_CONFIG_DIR="${HOME}/.claude"
VOLUME ["${HOME}/.claude"]

# Install Codex
RUN bun install -g @openai/codex

ENV CODEX_HOME="${HOME}/.codex"
VOLUME ["${HOME}/.codex"]

# Install Opencode
RUN bun install -g opencode-ai@latest

# Setup opencode XDG symlinks
RUN mkdir -p $HOME/.local/share $HOME/.local/state $HOME/.local/cache && \
  ln -s $HOME/.opencode/opencode-data $HOME/.local/share/opencode && \
  ln -s $HOME/.opencode/opencode-state $HOME/.local/state/opencode && \
  ln -s $HOME/.opencode/opencode-cache $HOME/.local/cache/opencode

# Install ampcode (links to ~/.local/bin)
RUN curl -fsSL https://ampcode.com/install.sh | bash

ENV OPENCODE_CONFIG_DIR="${HOME}/.opencode"
VOLUME ["${HOME}/.opencode"]

WORKDIR /app

# Copy root package.json
COPY package.json ./

# Copy server with its deps
COPY --from=build /app/server/ server/

# Copy shared common module
COPY --from=build /app/common/ common/

# Copy built web assets
COPY --from=build /app/web/build/ web/build/

ENV GARCON_CONFIG_DIR="${HOME}/.garcon"
ENV GARCON_BIND_ADDRESS=0.0.0.0
ENV GARCON_PROJECT_BASE_DIR="/"
ENV GARCON_PORT=8080
VOLUME ["${HOME}/.garcon"]
EXPOSE 8080

CMD ["bun", "server/main.js"]
