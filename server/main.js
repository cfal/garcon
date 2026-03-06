#!/usr/bin/env bun

function printHelp() {
  const helpText = `Garcon Server

Usage:
  bun server/main.js [options]
  bun run start -- [options]

Options:
  --help, -h                     Show this help screen and exit.
  --port <number>                Listen port (0..65535). Use 0 for a random port.
  --bind-address <host-or-ip>    Bind hostname/address for Bun server.
  --disable-auth                 Disable all HTTP/WebSocket authentication checks.
  --config-dir <directory>       Override Garcon config directory.
  --workspace-dir <directory>    Use an explicit workspace directory path.
  --workspace <name>             Use workspace name under config dir (workspace-<name>).
  --project-base-dir <directory> Restrict file access to a project root directory.

Environment Variables:
  GARCON_PORT                      Listen port (0..65535). If 0, picks a random port.
  GARCON_BIND_ADDRESS              Bind hostname/address. Default: 127.0.0.1
  GARCON_DISABLE_AUTH              Disable all HTTP/WebSocket authentication checks.
  GARCON_CONFIG_DIR                Base config directory. Default: ~/.garcon
  GARCON_WORKSPACE_DIR             Explicit workspace directory path.
  GARCON_WORKSPACE                 Workspace suffix under config dir. Default: default
  GARCON_JWT_TOKEN_EXPIRY          JWT expiry for auth tokens. Default: 30d
  GARCON_PROJECT_BASE_DIR          Restricts project file access to this resolved path.
  GARCON_TERMINAL_SHELL            Shell executable for PTY sessions (non-Windows).
  GARCON_MAX_REQUEST_BODY_SIZE     HTTP request body size limit (bytes). Default: 52428800
  GARCON_MAX_CONNECTIONS           Max concurrent HTTP connections. Default: 1024
  GARCON_MAX_WS_CLIENTS            Max pending websocket clients. Default: 128
  GARCON_WS_IDLE_TIMEOUT_SECONDS   WebSocket idle timeout seconds. Default: 960
  GARCON_WS_BACKPRESSURE_LIMIT     WebSocket backpressure limit (bytes). Default: 2097152
  GARCON_WS_MAX_PAYLOAD_LENGTH     WebSocket max payload length (bytes). Default: 16777216
  GARCON_HTTP_IDLE_TIMEOUT_SECONDS HTTP idle timeout seconds. Default: 120
  CLAUDE_BINARY                    Claude CLI binary path. Default: claude
  SHELL                            Fallback shell path when GARCON_TERMINAL_SHELL is unset.

Notes:
  Environment variables take precedence over CLI options where both are available.
  Server and PTY/provider subprocesses inherit the current process environment.
`;
  process.stdout.write(helpText);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
} else {
  const { startServer } = await import('./server.js');
  await startServer();
}
