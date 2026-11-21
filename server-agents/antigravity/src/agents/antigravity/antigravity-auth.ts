import type { AgentAuthStatus } from '@garcon/common/agent-execution';
import type { CliLoginCommand } from '@garcon/server-agent-common/auth/cli-login-controller';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';
import {
  antigravityCliFailure,
  runAntigravityModels,
  type AntigravityCliResult,
} from './antigravity-models.js';

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

export async function getAntigravityAuthStatus(
  config: AntigravityConfig,
  runModels: (config: AntigravityConfig) => Promise<AntigravityCliResult> = runAntigravityModels,
  signal?: AbortSignal,
): Promise<AgentAuthStatus> {
  try {
    // Sessions authenticate with the configured method only, so status must not
    // fall back to another credential the CLI happens to hold.
    if (config.authMethod() === 'gemini-api-key') {
      return config.hasApiKey()
        ? { authenticated: true, canReauth: true, label: 'GEMINI_API_KEY', source: 'environment' }
        : { authenticated: false, canReauth: true, label: '', source: 'none', detail: 'GEMINI_API_KEY is not set.' };
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
      canReauth: true,
      label: '',
      source: 'none',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// Remote-friendly Google sign-in: prints a link, then reads the pasted code.
export function antigravityLoginCommand(config: AntigravityConfig): CliLoginCommand {
  return [config.binary(), 'acp', '--login'];
}

// Without a display the CLI prints its sign-in link instead of opening a browser
// (t3code apps/server/src/provider/Drivers/AntigravityDriver.ts:402-474 at be91767).
export function antigravityLoginEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(antigravityChildEnvironment())) {
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
