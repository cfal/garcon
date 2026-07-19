import type { CodexConfigObject } from '@garcon/server-agent-common/legacy/session-types';
import type { AgentEndpointRuntimeConfig, AgentEndpointSelection } from '@garcon/server-agent-common/legacy/types';

export function buildCodexAppServerEndpointRuntime(selection: AgentEndpointSelection): AgentEndpointRuntimeConfig | undefined {
  if (selection.modelProtocol !== 'openai-compatible') return undefined;
  if (!selection.endpoint.capabilities?.responses) return undefined;

  const providerId = codexProviderIdForEndpoint(selection.endpoint.id);
  const envKey = selection.endpoint.apiKey ? codexApiKeyEnvForEndpoint(selection.endpoint.id) : null;
  const providerConfig: CodexConfigObject = {
    name: selection.apiProvider.label || selection.endpoint.id,
    base_url: selection.endpoint.baseUrl,
    wire_api: 'responses',
    requires_openai_auth: false,
    supports_websockets: false,
  };

  if (envKey) providerConfig.env_key = envKey;
  if (selection.endpoint.headers && Object.keys(selection.endpoint.headers).length > 0) {
    providerConfig.http_headers = { ...selection.endpoint.headers };
  }

  return {
    codexConfig: {
      config: {
        model_provider: providerId,
        model_providers: {
          [providerId]: providerConfig,
        },
      },
      ...(envKey ? { env: { [envKey]: selection.endpoint.apiKey } } : {}),
    },
  };
}

function codexProviderIdForEndpoint(endpointId: string): string {
  return `garcon_${endpointId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function codexApiKeyEnvForEndpoint(endpointId: string): string {
  return `GARCON_CODEX_PROVIDER_API_KEY_${endpointId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
