import { tmpdir } from 'node:os';
import type { AgentAuthStatus } from '@garcon/common/agent-execution';
import { AcpClient } from '@garcon/server-agent-common/acp/client';
import { AcpTransport } from '@garcon/server-agent-common/acp/transport';
import type { CliLoginCommand } from '@garcon/server-agent-common/auth/cli-login-controller';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';
import {
  antigravityCliFailure,
  runAntigravityModels,
  type AntigravityCliResult,
} from './antigravity-models.js';
import { sharedProbe } from './shared-probe.js';

// The probe is shared with concurrent callers, so an abort stops waiting rather
// than killing it.
function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const AUTHENTICATE_PROBE_TIMEOUT_MS = 10_000;

const inFlightAuthentication = new Map<string, Promise<void>>();

// Runs the ACP authenticate call every session makes. It runs without a display,
// so an OAuth method reports a missing sign-in instead of opening a browser.
// Concurrent status checks share one probe, bounded by its request timeout.
export function probeAntigravityAuthentication(config: AntigravityConfig): Promise<void> {
  const binary = config.binary();
  const method = config.authMethod();
  return sharedProbe(inFlightAuthentication, JSON.stringify([binary, method]), () => authenticateOnce(binary, method, config));
}

async function authenticateOnce(binary: string, method: string, config: AntigravityConfig): Promise<void> {
  const client = new AcpClient(new AcpTransport({ requestTimeoutMs: AUTHENTICATE_PROBE_TIMEOUT_MS }), {
    initialize: { protocolVersion: 1, clientInfo: { name: 'garcon', version: '1.0.0' }, clientCapabilities: {} },
    authenticateMethodId: method,
  });
  try {
    await client.connect({ command: binary, args: ['acp'], cwd: tmpdir(), env: antigravityLoginEnvironment(config) });
  } finally {
    client.close();
  }
}

export interface AntigravityAuthStatusOptions {
  readonly runModels?: (config: AntigravityConfig) => Promise<AntigravityCliResult>;
  readonly authenticate?: (config: AntigravityConfig) => Promise<void>;
  readonly signal?: AbortSignal;
  // Settings polls status while an in-app sign-in waits for its code. The CLI
  // cannot change state until that sign-in exits, so the last probed status
  // stands in for the probe meanwhile.
  readonly signInRunning?: boolean;
  readonly lastProbed?: AgentAuthStatus | null;
}

export async function getAntigravityAuthStatus(
  config: AntigravityConfig,
  {
    runModels = runAntigravityModels,
    authenticate = probeAntigravityAuthentication,
    signal,
    signInRunning = false,
    lastProbed = null,
  }: AntigravityAuthStatusOptions = {},
): Promise<AgentAuthStatus> {
  try {
    // Sessions authenticate with the configured method only, so status must not
    // fall back to another credential the CLI happens to hold. A Google sign-in
    // cannot change an API-key setup, so none is offered for it.
    if (config.authMethod() === 'gemini-api-key') {
      return config.hasApiKey()
        ? { authenticated: true, canReauth: false, label: 'GEMINI_API_KEY', source: 'environment' }
        : { authenticated: false, canReauth: false, label: '', source: 'none', detail: 'GEMINI_API_KEY is not set.' };
    }
    if (signInRunning) {
      return lastProbed ?? { authenticated: false, canReauth: true, label: '', source: 'none', detail: 'Sign-in in progress.' };
    }
    // In-app sign-in (`agy acp --login`) stores a personal Google login, which
    // `agy models` proves usable. `agy models` accepts any credential the CLI
    // holds, so an enterprise method instead asks agy to authenticate with it.
    const method = config.authMethod();
    if (method !== 'oauth-personal') {
      await abortable(authenticate(config), signal);
      return { authenticated: true, canReauth: false, label: method, source: 'cli' };
    }
    const result = await abortable(runModels(config), signal);
    if (result.exitCode === 0) {
      return { authenticated: true, canReauth: true, label: 'Google', source: 'cli' };
    }
    return {
      authenticated: false,
      canReauth: true,
      label: '',
      source: 'none',
      detail: antigravityCliFailure(result),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      authenticated: false,
      // A failed probe or invalid setting is not fixed by a personal sign-in
      // unless that is the configured method.
      canReauth: offersPersonalSignIn(config),
      label: '',
      source: 'none',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function offersPersonalSignIn(config: AntigravityConfig): boolean {
  try {
    return config.authMethod() === 'oauth-personal';
  } catch {
    return false;
  }
}

// Remote-friendly Google sign-in: prints a link, then reads the pasted code.
export function antigravityLoginCommand(config: AntigravityConfig): CliLoginCommand {
  return [config.binary(), 'acp', '--login'];
}

// Without a display the CLI prints its sign-in link instead of opening a browser
// (https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/apps/server/src/provider/Drivers/AntigravityDriver.ts#L402-L474).
export function antigravityLoginEnvironment(config: Pick<AntigravityConfig, 'apiKey' | 'authMethod'>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(antigravityChildEnvironment(config))) {
    if (value !== undefined && key !== 'DISPLAY' && key !== 'WAYLAND_DISPLAY') env[key] = value;
  }
  return env;
}

// The CLI accepts the code shown on its callback page or that page's full URL.
export function validateAntigravityLoginCode(code: string): string | null {
  if (/\s/.test(code)) return 'Paste only the authorization code or the final page URL.';
  if (code.startsWith('http') && !URL.canParse(code)) return 'The pasted URL is not valid.';
  return null;
}
