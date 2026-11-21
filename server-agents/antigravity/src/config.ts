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

function usesApiKey(config: Pick<AntigravityConfig, 'authMethod'>): boolean {
  try {
    return config.authMethod() === 'gemini-api-key';
  } catch {
    return false;
  }
}

function isAntigravityAuthMethod(value: string): value is AntigravityAuthMethod {
  return (ANTIGRAVITY_AUTH_METHODS as readonly string[]).includes(value);
}

// The CLI's background updater would replace a binary that running sessions
// use. The key comes from the integration's environment reader, the same source
// auth status and the auth method use, rather than whatever process.env holds.
export function antigravityChildEnvironment(
  config: Pick<AntigravityConfig, 'apiKey' | 'authMethod'>,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  // Only the API-key method sees a key, so neither sessions nor the status probe
  // can succeed on a credential other than the configured one.
  const { GEMINI_API_KEY: _ambient, ...env } = process.env;
  const apiKey = usesApiKey(config) ? config.apiKey() : null;
  return { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: '1', ...(apiKey ? { GEMINI_API_KEY: apiKey } : {}), ...overrides };
}
