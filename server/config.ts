// Single source of truth for server configuration derived from environment
// variables and CLI flags. Other server modules use getters from here instead
// of reading process.env or process.argv directly.

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

export interface ServerConfig {
  configDir: string;
  workspaceDir: string;
  port: number;
  bindAddress: string;
  claudeBinary: string;
  ampBinary: string;
  factoryBinary: string;
  piBinary: string;
  cursorBinary: string;
  jwtTokenExpiry: string;
  anthropicApiKey: string | null;
  anthropicBaseUrl: string | null;
  openAiApiKey: string | null;
  openAiBaseUrl: string | null;
  codexHome: string;
  cursorApiKey: string | null;
  factoryApiKey: string | null;
  piSessionDirOverride: string | null;
  homeDir: string;
  packageVersion: string;
  testEnvironment: boolean;
  projectBasePath: string;
  userShell: string;
  maxRequestBodySize: number;
  maxConnections: number;
  maxWsClients: number;
  wsIdleTimeoutSeconds: number;
  wsBackpressureLimit: number;
  wsMaxPayloadLength: number;
  httpIdleTimeoutSeconds: number;
  maxSessions: number;
  authDisabled: boolean;
  trustProxyEnabled: boolean;
  httpCompressionEnabled: boolean;
}

let activeConfig: Readonly<ServerConfig> | null = null;

export function initializeServerConfig(): Readonly<ServerConfig> {
  activeConfig = Object.freeze(parseServerConfig());
  return activeConfig;
}

export function resetServerConfigForTests(): void {
  activeConfig = null;
}

function currentConfig(): Readonly<ServerConfig> {
  return activeConfig ?? parseServerConfig();
}

function localServerBinary(name: string): string | null {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const candidate = path.join(SERVER_DIR, 'node_modules', '.bin', `${name}${suffix}`);
  return existsSync(candidate) ? candidate : null;
}

function envValue(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

function trimmedEnvValue(name: string): string | null {
  const value = envValue(name);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

function parseServerConfig(): ServerConfig {
  const configDir = parseConfigDir();
  return {
    configDir,
    workspaceDir: parseWorkspaceDir(configDir),
    port: parsePortConfig(),
    bindAddress: parseBindAddress(),
    claudeBinary: envValue('CLAUDE_BINARY') ?? 'claude',
    ampBinary: envValue('AMP_BINARY') ?? 'amp',
    factoryBinary: envValue('FACTORY_BINARY') ?? 'droid',
    piBinary: envValue('GARCON_PI_BINARY')
      ?? envValue('PI_BINARY')
      ?? localServerBinary('pi')
      ?? 'pi',
    cursorBinary: envValue('GARCON_CURSOR_BINARY')
      ?? envValue('CURSOR_BINARY')
      ?? localServerBinary('cursor-agent')
      ?? localServerBinary('agent')
      ?? 'cursor-agent',
    jwtTokenExpiry: envValue('GARCON_JWT_TOKEN_EXPIRY') ?? '30d',
    anthropicApiKey: trimmedEnvValue('ANTHROPIC_API_KEY'),
    anthropicBaseUrl: trimmedEnvValue('ANTHROPIC_BASE_URL'),
    openAiApiKey: trimmedEnvValue('OPENAI_API_KEY'),
    openAiBaseUrl: trimmedEnvValue('OPENAI_BASE_URL'),
    codexHome: envValue('CODEX_HOME') ?? path.join(os.homedir(), '.codex'),
    cursorApiKey: trimmedEnvValue('CURSOR_API_KEY'),
    factoryApiKey: trimmedEnvValue('FACTORY_API_KEY'),
    piSessionDirOverride: trimmedEnvValue('PI_CODING_AGENT_SESSION_DIR'),
    homeDir: envValue('HOME') ?? os.homedir(),
    packageVersion: envValue('npm_package_version') ?? '0.1.0',
    testEnvironment: envValue('NODE_ENV') === 'test',
    projectBasePath: parseProjectBasePath(),
    userShell: parseUserShell(),
    maxRequestBodySize: envInt('MAX_REQUEST_BODY_SIZE', 50 * 1024 * 1024),
    maxConnections: envInt('MAX_CONNECTIONS', 1024),
    maxWsClients: envInt('MAX_WS_CLIENTS', 128),
    wsIdleTimeoutSeconds: envInt('WS_IDLE_TIMEOUT_SECONDS', 60 * 16),
    wsBackpressureLimit: envInt('WS_BACKPRESSURE_LIMIT', 2 * 1024 * 1024),
    wsMaxPayloadLength: envInt('WS_MAX_PAYLOAD_LENGTH', 16 * 1024 * 1024),
    httpIdleTimeoutSeconds: envInt('HTTP_IDLE_TIMEOUT_SECONDS', 60 * 2),
    maxSessions: envInt('MAX_SESSIONS', 50),
    authDisabled: parseAuthDisabled(),
    trustProxyEnabled: envBool('TRUST_PROXY', false),
    httpCompressionEnabled: envBool('HTTP_COMPRESSION', true),
  };
}

function parseConfigDir(): string {
  const envConfigDir = envValue('GARCON_CONFIG_DIR');
  if (envConfigDir !== null) return envConfigDir;

  const configDir = cliValue('--config-dir');
  if (configDir !== null) return configDir;

  return path.join(os.homedir(), '.garcon');
}

function parseWorkspaceDir(configDir: string): string {
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
  return path.join(configDir, workspace);
}

function parsePortConfig(): number {
  const envPort = envValue('GARCON_PORT');
  if (envPort !== null) return parsePort(envPort, 'GARCON_PORT');

  const port = cliValue('--port');
  if (port !== null) return parsePort(port, '--port');

  return 8080;
}

function parseBindAddress(): string {
  const bindAddress = nonEmptyValue(
    envValue('GARCON_BIND_ADDRESS') ?? cliValue('--bind-address'),
    'Invalid --bind-address value: must be a non-empty hostname or IP address.',
  );
  if (bindAddress !== null) return bindAddress;

  return '127.0.0.1';
}

function parseProjectBasePath(): string {
  const projectBaseDir = nonEmptyValue(
    envValue('GARCON_PROJECT_BASE_DIR') ?? cliValue('--project-base-dir'),
    'Invalid --project-base-dir value: must be a non-empty directory path.',
  );
  if (projectBaseDir !== null) return path.resolve(projectBaseDir);

  return os.homedir();
}

function parseUserShell(): string {
  return os.platform() === 'win32'
    ? 'powershell.exe'
    : (envValue('GARCON_TERMINAL_SHELL') ?? envValue('SHELL') ?? '/bin/bash');
}

function parseAuthDisabled(): boolean {
  if (process.env.GARCON_DISABLE_AUTH !== undefined && process.env.GARCON_DISABLE_AUTH.trim() !== '') {
    return envBool('DISABLE_AUTH', false);
  }
  return process.argv.includes('--disable-auth');
}

export function getConfigDir(): string {
  return currentConfig().configDir;
}

export function getWorkspaceDir(): string {
  return currentConfig().workspaceDir;
}

export function getPort(): number {
  return currentConfig().port;
}

export function getBindAddress(): string {
  return currentConfig().bindAddress;
}

// Claude CLI binary path
export function getClaudeBinary(): string {
  return currentConfig().claudeBinary;
}

// Amp CLI binary path
export function getAmpBinary(): string {
  return currentConfig().ampBinary;
}

// Factory Droid CLI binary path
export function getFactoryBinary(): string {
  return currentConfig().factoryBinary;
}

// Pi CLI binary path
export function getPiBinary(): string {
  return currentConfig().piBinary;
}

// Cursor Agent CLI binary path
export function getCursorBinary(): string {
  return currentConfig().cursorBinary;
}

// JWT token expiry (secret is managed by auth/store).
export function getJwtTokenExpiry(): string {
  return currentConfig().jwtTokenExpiry;
}

export function getAnthropicApiKey(): string | null {
  return currentConfig().anthropicApiKey;
}

export function getAnthropicBaseUrl(): string | null {
  return currentConfig().anthropicBaseUrl;
}

export function getOpenAiApiKey(): string | null {
  return currentConfig().openAiApiKey;
}

export function getOpenAiBaseUrl(): string | null {
  return currentConfig().openAiBaseUrl;
}

export function getCodexHome(): string {
  return currentConfig().codexHome;
}

export function getCursorApiKey(): string | null {
  return currentConfig().cursorApiKey;
}

export function getFactoryApiKey(): string | null {
  return currentConfig().factoryApiKey;
}

export function getPiSessionDirOverride(): string | null {
  return currentConfig().piSessionDirOverride;
}

export function getHomeDir(): string {
  return currentConfig().homeDir;
}

export function getPackageVersion(): string {
  return currentConfig().packageVersion;
}

export function isTestEnvironment(): boolean {
  return currentConfig().testEnvironment;
}

// File access boundary
export function getProjectBasePath(): string {
  return currentConfig().projectBasePath;
}

// User shell for PTY sessions
export function getUserShell(): string {
  return currentConfig().userShell;
}

// HTTP / WebSocket server tuning
export function getMaxRequestBodySize(): number {
  return currentConfig().maxRequestBodySize;
}

export function getMaxConnections(): number {
  return currentConfig().maxConnections;
}

export function getMaxWsClients(): number {
  return currentConfig().maxWsClients;
}

export function getWsIdleTimeoutSeconds(): number {
  return currentConfig().wsIdleTimeoutSeconds;
}

export function getWsBackpressureLimit(): number {
  return currentConfig().wsBackpressureLimit;
}

export function getWsMaxPayloadLength(): number {
  return currentConfig().wsMaxPayloadLength;
}

export function getHttpIdleTimeoutSeconds(): number {
  return currentConfig().httpIdleTimeoutSeconds;
}

export function getMaxSessions(): number {
  return currentConfig().maxSessions;
}

export function isAuthDisabled(): boolean {
  return currentConfig().authDisabled;
}

export function isTrustProxyEnabled(): boolean {
  return currentConfig().trustProxyEnabled;
}

export function isHttpCompressionEnabled(): boolean {
  return currentConfig().httpCompressionEnabled;
}

// Parses an integer from an environment variable, returning the fallback when absent.
function envInt(name: string, fallback: number): number {
  const varName = 'GARCON_' + name;
  const raw = process.env[varName];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid ${varName} value: ${raw}. Must be a non-negative integer.`);
  }
  const parsed = Number(normalized);
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
