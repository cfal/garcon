import { tmpdir } from 'node:os';
import type { AgentAuthStatus } from '@garcon/common/agent-execution';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { AcpClient } from '@garcon/server-agent-common/acp/client';
import { garconInitializeParams } from '@garcon/server-agent-common/acp/protocol';
import { AcpTransport } from '@garcon/server-agent-common/acp/transport';
import type { CliLoginCommand } from '@garcon/server-agent-common/auth/cli-login-controller';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { antigravityChildEnvironment, authMethodOrNull, classifyAntigravityLaunchError, type AntigravityConfig } from '../../config.js';
import {
  antigravityCliFailure,
  runAntigravityModels,
  type AntigravityCliResult,
} from './antigravity-models.js';
import { sharedProbe, waitUnlessAborted } from '@garcon/server-agent-common/shared/shared-probe';

const AUTHENTICATE_PROBE_TIMEOUT_MS = 10_000;

interface AntigravityProbes {
  readonly runModels: () => Promise<AntigravityCliResult>;
  readonly authenticate: () => Promise<void>;
}

// A completed login replaces both in-flight probes and their last observed status.
export function createAntigravityProbes(config: AntigravityConfig): AntigravityProbes & { lastProbed: AgentAuthStatus | null } {
  const authentication = new Map<string, Promise<void>>();
  const models = new Map<string, Promise<AntigravityCliResult>>();
  return {
    lastProbed: null,
    authenticate: () => sharedProbe(authentication, JSON.stringify([config.binary(), config.authMethod()]),
      () => authenticateOnce(config)),
    runModels: () => sharedProbe(models, JSON.stringify([config.binary(), config.authMethod(), config.apiKey()]),
      () => runAntigravityModels(config)),
  };
}

async function authenticateOnce(config: AntigravityConfig): Promise<void> {
  const client = new AcpClient(new AcpTransport({ requestTimeoutMs: AUTHENTICATE_PROBE_TIMEOUT_MS }), {
    initialize: garconInitializeParams(),
    authenticateMethodId: config.authMethod(),
  });
  try {
    await client.connect({ command: config.binary(), args: ['acp'], cwd: tmpdir(), env: antigravityLoginEnvironment(config) });
  } finally {
    client.close();
  }
}

export interface AntigravityAuthStatusOptions extends AntigravityProbes {
  // Dropping the display keeps agy from opening a browser only on Linux; on
  // macOS it would open one on every status check of a signed-out OAuth method.
  readonly headlessAuthenticate?: boolean;
  readonly signal?: AbortSignal;
  // Settings polls status while an in-app sign-in waits for its code. The CLI
  // cannot change state until that sign-in exits, so the last probed status
  // stands in for the probe meanwhile.
  readonly signInRunning?: boolean;
  readonly lastProbed?: AgentAuthStatus | null;
}

function signedOut(canReauth: boolean, detail: string): AgentAuthStatus {
  return { authenticated: false, canReauth, label: '', source: 'none', detail };
}

export async function getAntigravityAuthStatus(
  config: AntigravityConfig,
  {
    runModels,
    authenticate,
    headlessAuthenticate = process.platform === 'linux',
    signal,
    signInRunning = false,
    lastProbed = null,
  }: AntigravityAuthStatusOptions,
): Promise<AgentAuthStatus> {
  signal?.throwIfAborted();
  try {
    // Sessions authenticate with the configured method only, so status must not
    // fall back to another credential the CLI happens to hold. A Google sign-in
    // cannot change an API-key setup, so none is offered for it.
    const method = config.authMethod();
    // Even API-key sessions require a runnable CLI on this executor.
    const binary = config.binary();
    if (method === 'gemini-api-key') {
      if (!config.apiKey()) return signedOut(false, 'GEMINI_API_KEY is not set.');
      const probe = Bun.spawn([binary, '--version'], {
        env: antigravityChildEnvironment(config), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
        signal: AbortSignal.any([AbortSignal.timeout(AUTHENTICATE_PROBE_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      });
      if (await probe.exited !== 0) throw new Error('Antigravity CLI version check failed.');
      signal?.throwIfAborted();
      return { authenticated: true, canReauth: false, label: 'GEMINI_API_KEY', source: 'environment' };
    }
    if (signInRunning) {
      return lastProbed ?? signedOut(true, 'Sign-in in progress.');
    }
    // Model listing accepts any cached credential. Prefer the same method
    // check as a real session wherever it cannot open a browser.
    const canReauth = method === 'oauth-personal';
    if (headlessAuthenticate) {
      await waitUnlessAborted(authenticate(), signal);
    } else {
      const result = await waitUnlessAborted(runModels(), signal);
      if (result.exitCode !== 0) {
        return signedOut(canReauth, antigravityCliFailure(result));
      }
    }
    return { authenticated: true, canReauth, label: canReauth ? 'Google' : method, source: 'cli' };
  } catch (cause) {
    signal?.throwIfAborted();
    const error = classifyAntigravityLaunchError(cause);
    const canReauth = !(error instanceof AgentIntegrationError && error.code === 'BINARY_NOT_FOUND')
      && authMethodOrNull(config) === 'oauth-personal';
    return signedOut(canReauth, errorMessage(error));
  }
}

// Remote-friendly Google sign-in: prints a link, then reads the pasted code.
export function antigravityLoginCommand(config: AntigravityConfig): CliLoginCommand {
  if (config.authMethod() !== 'oauth-personal') {
    throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'In-app Antigravity sign-in requires oauth-personal.', false);
  }
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
