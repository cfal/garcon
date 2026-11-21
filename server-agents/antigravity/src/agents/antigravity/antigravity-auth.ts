import type { AgentAuthStatus } from '@garcon/common/agent-execution';
import type { CliLoginCommand } from '@garcon/server-agent-common/auth/cli-login-controller';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';
import {
  antigravityCliFailure,
  runAntigravityModels,
  type AntigravityCliResult,
} from './antigravity-models.js';

export async function getAntigravityAuthStatus(
  config: AntigravityConfig,
  runModels: (config: AntigravityConfig) => Promise<AntigravityCliResult> = runAntigravityModels,
): Promise<AgentAuthStatus> {
  try {
    if (config.authMethod() === 'gemini-api-key' && config.hasApiKey()) {
      return { authenticated: true, canReauth: true, label: 'GEMINI_API_KEY', source: 'environment' };
    }
    const result = await runModels(config);
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
