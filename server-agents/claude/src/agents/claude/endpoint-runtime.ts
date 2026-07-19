import type { ResolvedAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import type { ClaudeConfig } from '../../config.js';

export interface ClaudeEndpointRuntime {
  readonly envOverrides: Record<string, string>;
}

export function buildClaudeEndpointRuntime(
  endpoint: ResolvedAgentEndpoint,
): ClaudeEndpointRuntime | null {
  if (endpoint.selection.protocol !== 'anthropic-messages') return null;

  return {
    envOverrides: {
      ANTHROPIC_BASE_URL: endpoint.selection.baseUrl,
      ...(endpoint.credential ? { ANTHROPIC_AUTH_TOKEN: endpoint.credential } : {}),
      ANTHROPIC_API_KEY: '',
    },
  };
}

export function buildClaudeHostEnvironment(
  config: ClaudeConfig,
): Record<string, string> | undefined {
  const values = {
    ANTHROPIC_API_KEY: config.anthropicApiKey(),
    ANTHROPIC_BASE_URL: config.anthropicBaseUrl(),
    CLAUDE_CONFIG_DIR: config.configHomeDir(),
  };
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
