// Single source of truth for all server configuration derived from environment
// variables. Every other server module should import getters from here instead
// of reading process.env directly.

import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

const CLI_VALUE_FLAGS = {
  '--config-dir': '<directory>',
  '--workspace-dir': '<directory>',
  '--workspace': '<name>',
  '--port': '<number>',
  '--bind-address': '<hostname-or-ip>',
  '--project-base-dir': '<directory>',
} as const;

type CliValueFlag = keyof typeof CLI_VALUE_FLAGS;

function localServerBinary(name: string): string | null {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const candidate = path.join(SERVER_DIR, 'node_modules', '.bin', `${name}${suffix}`);
  return existsSync(candidate) ? candidate : null;
}

function envValue(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

function cliValue(flag: CliValueFlag): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  if (index + 1 >= process.argv.length) {
    throw new Error(`${flag} requires a value. Usage: ${flag} ${CLI_VALUE_FLAGS[flag]}`);
  }
  return process.argv[index + 1] ?? null;
}

function nonEmptyValue(value: string | null, errorMessage: string): string | null {
  if (value === null) return null;
  if (value.trim() === '') {
    throw new Error(errorMessage);
  }
  return value;
}

function parsePort(value: string, source: string): number {
  if (value.trim() === '') {
    throw new Error(`Invalid ${source} value: must be an integer between 0 and 65535.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid ${source} value: ${value}. Must be an integer between 0 and 65535.`);
  }
  return parsed;
}

// Garcon config directory
export function getConfigDir(): string {
  const envConfigDir = envValue('GARCON_CONFIG_DIR');
  if (envConfigDir !== null) return envConfigDir;

  const configDir = cliValue('--config-dir');
  if (configDir !== null) return configDir;

  return path.join(os.homedir(), '.garcon');
}

export function getWorkspaceDir(): string {
  const workspaceDir = nonEmptyValue(
    envValue('GARCON_WORKSPACE_DIR') ?? cliValue('--workspace-dir'),
    'Invalid --workspace-dir value: must be a non-empty directory path.',
  );
  if (workspaceDir !== null) return workspaceDir;

  let workspace: string;
  const envWorkspace = envValue('GARCON_WORKSPACE');
  if (envWorkspace !== null) {
    workspace = 'workspace-' + envWorkspace;
  } else {
    const workspaceName = nonEmptyValue(
      cliValue('--workspace'),
      'Invalid --workspace value: must be a non-empty name.',
    );
    if (workspaceName !== null) {
      workspace = 'workspace-' + workspaceName;
    } else {
      workspace = 'workspace-default';
    }
  }
  return path.join(getConfigDir(), workspace);
}

// Server port
export function getPort(): number {
  const envPort = envValue('GARCON_PORT');
  if (envPort !== null) return parsePort(envPort, 'GARCON_PORT');

  const port = cliValue('--port');
  if (port !== null) return parsePort(port, '--port');

  return 8080;
}

// Server bind address / hostname
export function getBindAddress(): string {
  const bindAddress = nonEmptyValue(
    envValue('GARCON_BIND_ADDRESS') ?? cliValue('--bind-address'),
    'Invalid --bind-address value: must be a non-empty hostname or IP address.',
  );
  if (bindAddress !== null) return bindAddress;

  return '127.0.0.1';
}

// Claude CLI binary path
export function getClaudeBinary(): string {
  return envValue('CLAUDE_BINARY') ?? 'claude';
}

// Amp CLI binary path
export function getAmpBinary(): string {
  return envValue('AMP_BINARY') ?? 'amp';
}

// Factory Droid CLI binary path
export function getFactoryBinary(): string {
  return envValue('FACTORY_BINARY') ?? 'droid';
}

// Pi CLI binary path
export function getPiBinary(): string {
  return envValue('GARCON_PI_BINARY')
    ?? envValue('PI_BINARY')
    ?? localServerBinary('pi')
    ?? 'pi';
}

// Cursor Agent CLI binary path
export function getCursorBinary(): string {
  return envValue('GARCON_CURSOR_BINARY')
    ?? envValue('CURSOR_BINARY')
    ?? localServerBinary('cursor-agent')
    ?? localServerBinary('agent')
    ?? 'cursor-agent';
}

// JWT token expiry (secret is managed by auth/store.js).
export function getJwtTokenExpiry(): string {
  return envValue('GARCON_JWT_TOKEN_EXPIRY') ?? '30d';
}

// File access boundary
export function getProjectBasePath(): string {
  const projectBaseDir = nonEmptyValue(
    envValue('GARCON_PROJECT_BASE_DIR') ?? cliValue('--project-base-dir'),
    'Invalid --project-base-dir value: must be a non-empty directory path.',
  );
  if (projectBaseDir !== null) return path.resolve(projectBaseDir);

  // Default to the user's home directory
  return os.homedir();
}

// User shell for PTY sessions
export function getUserShell(): string {
  return os.platform() === 'win32'
    ? 'powershell.exe'
    : (envValue('GARCON_TERMINAL_SHELL') ?? envValue('SHELL') ?? '/bin/bash');
}

// HTTP / WebSocket server tuning
export function getMaxRequestBodySize(): number {
  return envInt('MAX_REQUEST_BODY_SIZE', 50 * 1024 * 1024);
}

export function getMaxConnections(): number {
  return envInt('MAX_CONNECTIONS', 1024);
}

export function getMaxWsClients(): number {
  return envInt('MAX_WS_CLIENTS', 128);
}

export function getWsIdleTimeoutSeconds(): number {
  // 960 is the max value accepted by Bun
  return envInt('WS_IDLE_TIMEOUT_SECONDS', 60 * 16);
}

export function getWsBackpressureLimit(): number {
  return envInt('WS_BACKPRESSURE_LIMIT', 2 * 1024 * 1024);
}

export function getWsMaxPayloadLength(): number {
  return envInt('WS_MAX_PAYLOAD_LENGTH', 16 * 1024 * 1024);
}

export function getHttpIdleTimeoutSeconds(): number {
  return envInt('HTTP_IDLE_TIMEOUT_SECONDS', 60 * 2);
}

export function getMaxSessions(): number {
  return envInt('MAX_SESSIONS', 50);
}

// Global authentication toggle.
// Env takes precedence over CLI to match the rest of config behavior.
export function isAuthDisabled(): boolean {
  if (process.env.GARCON_DISABLE_AUTH !== undefined) {
    return envBool('DISABLE_AUTH', false);
  }
  return process.argv.includes('--disable-auth');
}

export function isTrustProxyEnabled(): boolean {
  return envBool('TRUST_PROXY', false);
}

// Parses an integer from an environment variable, returning the fallback when
// absent or invalid.
function envInt(name: string, fallback: number): number {
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

function envBool(name: string, fallback: boolean): boolean {
  const varName = 'GARCON_' + name;
  const raw = process.env[varName];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid ${varName} value: ${raw}. Must be a boolean-like value.`);
}
