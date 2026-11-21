import { AgentIntegrationError, type AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { readEnvironment } from '@garcon/server-agent-common/environment/read-environment';

// The ACP auth methods agy advertises in its `initialize` result.
export const ANTIGRAVITY_AUTH_METHODS = [
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform',
] as const;

export type AntigravityAuthMethod = typeof ANTIGRAVITY_AUTH_METHODS[number];

export interface AntigravityConfig {
  readonly binary: () => string;
  readonly apiKey: () => string | null;
  readonly hasApiKey: () => boolean;
  readonly authMethod: () => AntigravityAuthMethod;
}

export function createAntigravityConfig(environment: AgentEnvironmentReader): AntigravityConfig {
  const apiKey = () => readEnvironment(environment, 'GEMINI_API_KEY');
  const hasApiKey = () => apiKey() !== null;
  return Object.freeze({
    binary: () => readEnvironment(environment, 'GARCON_ANTIGRAVITY_BINARY') ?? 'agy',
    apiKey,
    hasApiKey,
    authMethod: () => resolveAuthMethod(
      readEnvironment(environment, 'GARCON_ANTIGRAVITY_AUTH_METHOD'),
      hasApiKey(),
    ),
  });
}

export function resolveAuthMethod(
  configured: string | null,
  hasApiKey: boolean,
): AntigravityAuthMethod {
  if (configured !== null) {
    if (isAntigravityAuthMethod(configured)) return configured;
    throw new AgentIntegrationError(
      'INVALID_SETTINGS',
      `GARCON_ANTIGRAVITY_AUTH_METHOD must be one of ${ANTIGRAVITY_AUTH_METHODS.join(', ')}; received ${configured}.`,
      false,
    );
  }
  return hasApiKey ? 'gemini-api-key' : 'oauth-personal';
}

function isAntigravityAuthMethod(value: string): value is AntigravityAuthMethod {
  return (ANTIGRAVITY_AUTH_METHODS as readonly string[]).includes(value);
}

// The CLI's background updater would replace a binary that running sessions
// use. The key comes from the integration's environment reader, the same source
// auth status and the auth method use, rather than whatever process.env holds.
export function antigravityChildEnvironment(
  config: Pick<AntigravityConfig, 'apiKey'>,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  const apiKey = config.apiKey();
  return { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: '1', ...(apiKey ? { GEMINI_API_KEY: apiKey } : {}), ...overrides };
}
