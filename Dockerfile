# -- Build stage: install deps and compile SvelteKit frontend --
FROM oven/bun:latest AS build

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
FROM oven/bun:latest

RUN apt-get update && apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root package.json
COPY package.json ./

# Copy server with its deps
COPY --from=build /app/server/ server/

# Copy shared common module
COPY --from=build /app/common/ common/

# Copy built web assets
COPY --from=build /app/web/build/ web/build/

ENV GARCON_BIND_ADDRESS=0.0.0.0
EXPOSE 8080

CMD ["bun", "server/main.js"]
