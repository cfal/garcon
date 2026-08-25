ARG NODE_IMAGE=node:24-bookworm-slim
ARG BUN_IMAGE=oven/bun:1.4.0

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      less \
      openssh-client \
      procps \
      ripgrep && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

FROM base AS build

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY common/package.json common/
COPY server/package.json server/
COPY web/package.json web/
COPY cli/package.json cli/
COPY server-agents/interface/package.json server-agents/interface/
COPY server-agents/common/package.json server-agents/common/
COPY server-agents/amp/package.json server-agents/amp/
COPY server-agents/claude/package.json server-agents/claude/
COPY server-agents/codex/package.json server-agents/codex/
COPY server-agents/cursor/package.json server-agents/cursor/
COPY server-agents/direct-anthropic-compatible/package.json server-agents/direct-anthropic-compatible/
COPY server-agents/direct-openai-compatible/package.json server-agents/direct-openai-compatible/
COPY server-agents/direct-openai-responses-compatible/package.json server-agents/direct-openai-responses-compatible/
COPY server-agents/factory/package.json server-agents/factory/
COPY server-agents/opencode/package.json server-agents/opencode/
COPY server-agents/pi/package.json server-agents/pi/
COPY patches/ patches/

RUN bun install --frozen-lockfile

COPY common/ common/
COPY server/ server/
COPY server-agents/ server-agents/
COPY scripts/ scripts/
COPY web/ web/

RUN bun run build

FROM base AS runtime

ARG GARCON_UID=1000
ARG GARCON_GID=1000
ARG OPENCODE_VERSION=1.18.22

RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force
RUN set -eu; \
    if [ "${GARCON_UID}" -eq 0 ]; then \
      echo "GARCON_UID must identify a non-root user" >&2; \
      exit 1; \
    fi; \
    if [ "${GARCON_GID}" -eq 0 ]; then \
      echo "GARCON_GID must identify a non-root group" >&2; \
      exit 1; \
    fi; \
    userdel -r node 2>/dev/null || true; \
    runtime_user="$(getent passwd "${GARCON_UID}" | cut -d: -f1)"; \
    if [ -n "${runtime_user}" ]; then \
      echo "GARCON_UID ${GARCON_UID} is already assigned to ${runtime_user}" >&2; \
      exit 1; \
    fi; \
    runtime_group="$(getent group "${GARCON_GID}" | cut -d: -f1)"; \
    if [ -z "${runtime_group}" ]; then \
      runtime_group=garcon; \
      groupadd --gid "${GARCON_GID}" "${runtime_group}"; \
    fi; \
    useradd --create-home --uid "${GARCON_UID}" --gid "${runtime_group}" --shell /bin/bash garcon; \
    install -d -o "${GARCON_UID}" -g "${GARCON_GID}" /projects

ENV HOME=/home/garcon
ENV PATH="${HOME}/.local/bin:${PATH}"
ENV CLAUDE_CONFIG_DIR="${HOME}/.claude"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER garcon

RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://cursor.com/install | bash
RUN curl -fsSL https://ampcode.com/install.sh | bash
RUN curl -fsSL https://app.factory.ai/cli | sh

# Removes installer-created machine state before persistent volumes are initialized.
RUN rm -rf \
      "${HOME}/.agents" \
      "${HOME}/.claude" \
      "${HOME}/.claude.json" \
      "${HOME}/.codex" \
      "${HOME}/.config" \
      "${HOME}/.cursor" \
      "${HOME}/.factory" \
      "${HOME}/.garcon" \
      "${HOME}/.local/share/amp" \
      "${HOME}/.local/share/opencode" \
      "${HOME}/.local/state/opencode" \
      "${HOME}/.pi" \
      "${HOME}/.ssh" && \
    mkdir -p \
      "${HOME}/.agents" \
      "${HOME}/.claude" \
      "${HOME}/.codex" \
      "${HOME}/.config/amp" \
      "${HOME}/.config/gh" \
      "${HOME}/.config/git" \
      "${HOME}/.config/opencode" \
      "${HOME}/.cursor" \
      "${HOME}/.factory" \
      "${HOME}/.garcon" \
      "${HOME}/.local/share/amp" \
      "${HOME}/.local/share/opencode" \
      "${HOME}/.local/state/opencode" \
      "${HOME}/.pi" \
      "${HOME}/.ssh" && \
    chmod 700 "${HOME}/.ssh"

USER root
WORKDIR /app

COPY --from=build /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/server/ server/
COPY --from=build /app/common/ common/
COPY --from=build /app/server-agents/ server-agents/
COPY --from=build /app/web/build/ web/build/

RUN test -x /app/server-agents/codex/node_modules/.bin/codex && \
    test -x /app/server-agents/pi/node_modules/.bin/pi && \
    ln -s /app/server-agents/codex/node_modules/.bin/codex /usr/local/bin/codex && \
    ln -s /app/server-agents/pi/node_modules/.bin/pi /usr/local/bin/pi && \
    printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' > /etc/profile.d/garcon-path.sh

ENV CODEX_HOME="${HOME}/.codex"
ENV GARCON_CONFIG_DIR="${HOME}/.garcon"
ENV GARCON_BIND_ADDRESS=0.0.0.0
ENV GARCON_PORT=8080
ENV GARCON_PROJECT_BASE_DIR=/projects
ENV GIT_CONFIG_GLOBAL="${HOME}/.config/git/config"
ENV PI_CODING_AGENT_DIR="${HOME}/.pi/agent"
ENV PI_TELEMETRY=0
ENV SHELL=/bin/bash

EXPOSE 8080

USER garcon
CMD ["bun", "server/main.ts"]
