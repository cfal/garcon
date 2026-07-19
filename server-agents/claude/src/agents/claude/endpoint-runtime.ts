import type { AgentEndpointRuntimeConfig, AgentEndpointSelection } from '@garcon/server-agent-common/legacy/types';

export function buildClaudeEndpointRuntime(selection: AgentEndpointSelection): AgentEndpointRuntimeConfig | undefined {
  if (selection.modelProtocol !== 'anthropic-messages') return undefined;

  return {
    envOverrides: {
      ANTHROPIC_BASE_URL: selection.endpoint.baseUrl,
      ...(selection.endpoint.apiKey ? { ANTHROPIC_AUTH_TOKEN: selection.endpoint.apiKey } : {}),
      ANTHROPIC_API_KEY: '',
    },
  };
}
