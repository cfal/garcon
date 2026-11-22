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
  readonly authMethod: () => AntigravityAuthMethod;
}

export function createAntigravityConfig(environment: AgentEnvironmentReader): AntigravityConfig {
  const apiKey = () => readEnvironment(environment, 'GEMINI_API_KEY');
  return Object.freeze({
    binary: () => {
      const command = readEnvironment(environment, 'GARCON_ANTIGRAVITY_BINARY') ?? 'agy';
      // ACP runs in the chat project, never resolve a relative binary against it.
      const path = Bun.which(command, { cwd: process.cwd(), PATH: process.env.PATH });
      if (path) return path;
      throw new AgentIntegrationError('BINARY_NOT_FOUND',
        'Antigravity CLI not found on this executor. Install agy or set GARCON_ANTIGRAVITY_BINARY.', false);
    },
    apiKey,
    authMethod: () => resolveAuthMethod(
      readEnvironment(environment, 'GARCON_ANTIGRAVITY_AUTH_METHOD'),
      apiKey() !== null,
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

// The configured method, or null when the setting is invalid; callers that
// only ask whether a method applies treat an invalid setting as none.
export function authMethodOrNull(config: Pick<AntigravityConfig, 'authMethod'>): AntigravityAuthMethod | null {
  try {
    return config.authMethod();
  } catch {
    return null;
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
  const apiKey = authMethodOrNull(config) === 'gemini-api-key' ? config.apiKey() : null;
  // agy reads only `true`; with `1` it still spawns its updater (verified on 1.5.13).
  return { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', ...(apiKey ? { GEMINI_API_KEY: apiKey } : {}), ...overrides };
}
