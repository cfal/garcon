// Single source of truth for all server configuration derived from environment
// variables. Every other server module should import getters from here instead
// of reading process.env directly.

import path from 'path';
import os from 'os';

// Garcon config directory
export function getConfigDir() {
  if (process.env.GARCON_CONFIG_DIR) {
    return process.env.GARCON_CONFIG_DIR;
  }
  const configArgIndex = process.argv.indexOf('--config-dir');
  if (configArgIndex !== -1) {
    if (configArgIndex + 1 >= process.argv.length) {
      throw new Error('--config-dir requires a value. Usage: --config-dir <directory>');
    }
    return process.argv[configArgIndex + 1];
  }
  return path.join(os.homedir(), '.garcon');
}

export function getWorkspaceDir() {
  if (process.env.GARCON_WORKSPACE_DIR) {
    return process.env.GARCON_WORKSPACE_DIR;
  }
  const workspaceDirArgIndex = process.argv.indexOf('--workspace-dir');
  if (workspaceDirArgIndex !== -1) {
    if (workspaceDirArgIndex + 1 >= process.argv.length) {
      throw new Error('--workspace-dir requires a value. Usage: --workspace-dir <directory>');
    }
    const workspaceDir = process.argv[workspaceDirArgIndex + 1];
    if (!workspaceDir || workspaceDir.trim() === '') {
      throw new Error('Invalid --workspace-dir value: must be a non-empty directory path.');
    }
    return workspaceDir;
  }

  let workspace;
  if (process.env.GARCON_WORKSPACE) {
    workspace = 'workspace-' + process.env.GARCON_WORKSPACE;
  } else {
    const workspaceArgIndex = process.argv.indexOf('--workspace');
    if (workspaceArgIndex !== -1) {
      if (workspaceArgIndex + 1 >= process.argv.length) {
        throw new Error('--workspace requires a value. Usage: --workspace <name>');
      }
      const workspaceName = process.argv[workspaceArgIndex + 1];
      if (!workspaceName || workspaceName.trim() === '') {
        throw new Error('Invalid --workspace value: must be a non-empty name.');
      }
      workspace = 'workspace-' + workspaceName;
    } else {
      workspace = 'workspace-default';
    }
  }
  return path.join(getConfigDir(), workspace);
}

// Server port
export function getPort() {
  if (process.env.GARCON_PORT) {
    const envPort = Number(process.env.GARCON_PORT);
    if (!Number.isFinite(envPort) || envPort < 0 || envPort > 65535) {
      throw new Error(`Invalid GARCON_PORT value: ${process.env.GARCON_PORT}. Must be an integer between 0 and 65535.`);
    }
    if (envPort === 0) {
      return randomPort();
    }
    return envPort;
  }
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1) {
    if (portArgIndex + 1 >= process.argv.length) {
      throw new Error('--port requires a value. Usage: --port <number>');
    }
    const argPort = Number(process.argv[portArgIndex + 1]);
    if (!Number.isFinite(argPort) || argPort < 0 || argPort > 65535) {
      throw new Error(`Invalid --port value: ${process.argv[portArgIndex + 1]}. Must be an integer between 0 and 65535.`);
    }
    if (argPort === 0) {
      return randomPort();
    }
    return argPort;
  }
  return 8080;
}

// Server bind address / hostname
export function getBindAddress() {
  if (process.env.GARCON_BIND_ADDRESS) {
    return process.env.GARCON_BIND_ADDRESS;
  }
  const bindAddressArgIndex = process.argv.indexOf('--bind-address');
  if (bindAddressArgIndex !== -1) {
    if (bindAddressArgIndex + 1 >= process.argv.length) {
      throw new Error('--bind-address requires a value. Usage: --bind-address <hostname-or-ip>');
    }
    const bindAddress = process.argv[bindAddressArgIndex + 1];
    if (!bindAddress || bindAddress.trim() === '') {
      throw new Error('Invalid --bind-address value: must be a non-empty hostname or IP address.');
    }
    return bindAddress;
  }
  return '127.0.0.1';
}

// Claude CLI binary path
export function getClaudeBinary() {
  return process.env.CLAUDE_BINARY || 'claude';
}

// JWT token expiry (secret is managed by auth/store.js).
export function getJwtTokenExpiry() {
  return process.env.GARCON_JWT_TOKEN_EXPIRY || '30d';
}

// Static API key for token-less authentication.
// When set, requests bearing this key (as a Bearer token) bypass JWT/setup.
export function getApiKey() {
  return process.env.GARCON_API_KEY || null;
}

// File access boundary
export function getProjectBasePath() {
  if (process.env.GARCON_PROJECT_BASE_DIR) {
    return path.resolve(process.env.GARCON_PROJECT_BASE_DIR);
  }
  const projectBaseDirArgIndex = process.argv.indexOf('--project-base-dir');
  if (projectBaseDirArgIndex !== -1) {
    if (projectBaseDirArgIndex + 1 >= process.argv.length) {
      throw new Error('--project-base-dir requires a value. Usage: --project-base-dir <directory>');
    }
    const projectBaseDir = process.argv[projectBaseDirArgIndex + 1];
    if (!projectBaseDir || projectBaseDir.trim() === '') {
      throw new Error('Invalid --project-base-dir value: must be a non-empty directory path.');
    }
    return path.resolve(projectBaseDir);
  }
  // this returns a correct path for windows
  return path.resolve('/');
}

// User shell for PTY sessions
export function getUserShell() {
  return os.platform() === 'win32'
    ? 'powershell.exe'
    : (process.env.GARCON_TERMINAL_SHELL || process.env.SHELL || '/bin/bash');
}

// HTTP / WebSocket server tuning
export function getMaxRequestBodySize() {
  return envInt('MAX_REQUEST_BODY_SIZE', 50 * 1024 * 1024);
}

export function getMaxConnections() {
  return envInt('MAX_CONNECTIONS', 1024);
}

export function getMaxWsClients() {
  return envInt('MAX_WS_CLIENTS', 128);
}

export function getWsIdleTimeoutSeconds() {
  // 960 is the max value accepted by Bun
  return envInt('WS_IDLE_TIMEOUT_SECONDS', 60 * 16);
}

export function getWsBackpressureLimit() {
  return envInt('WS_BACKPRESSURE_LIMIT', 2 * 1024 * 1024);
}

export function getWsMaxPayloadLength() {
  return envInt('WS_MAX_PAYLOAD_LENGTH', 16 * 1024 * 1024);
}

export function getHttpIdleTimeoutSeconds() {
  return envInt('HTTP_IDLE_TIMEOUT_SECONDS', 60 * 2);
}

// Generate a random port in the range 8080..=65535.
function randomPort() {
  return 8080 + Math.floor(Math.random() * (65535 - 8080 + 1));
}

// Parses an integer from an environment variable, returning the fallback when
// absent or invalid.
function envInt(name, fallback) {
  const varName = 'GARCON_' + name;
  const raw = process.env[varName];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${varName} value: ${raw}. Must be an integer.`);
  }
  return parsed;
}
