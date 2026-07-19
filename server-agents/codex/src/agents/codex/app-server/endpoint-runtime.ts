import type { ResolvedAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import type { CodexConfig } from '../../../config.js';
import type { CodexConfigObject, CodexProviderConfig } from '../runtime-types.js';

export interface CodexEndpointRuntime {
  readonly codexConfig: CodexProviderConfig;
}

export function buildCodexAppServerEndpointRuntime(
  endpoint: ResolvedAgentEndpoint,
): CodexEndpointRuntime | null {
  if (endpoint.selection.protocol !== 'openai-compatible') return null;
  if (endpoint.selection.capabilities?.responses !== true) return null;

  const providerId = codexProviderIdForEndpoint(endpoint.selection.endpointId);
  const envKey = endpoint.credential
    ? codexApiKeyEnvForEndpoint(endpoint.selection.endpointId)
    : null;
  const providerConfig: CodexConfigObject = {
    name: endpoint.selection.providerLabel || endpoint.selection.apiProviderId,
    base_url: endpoint.selection.baseUrl,
    wire_api: 'responses',
    requires_openai_auth: false,
    supports_websockets: false,
  };

  if (envKey) providerConfig.env_key = envKey;
  if (Object.keys(endpoint.selection.headers).length > 0) {
    providerConfig.http_headers = { ...endpoint.selection.headers };
  }
  return {
    codexConfig: {
      config: {
        model_provider: providerId,
        model_providers: {
          [providerId]: providerConfig,
        },
      },
      ...(envKey ? { env: { [envKey]: endpoint.credential! } } : {}),
    },
  };
}

export function buildCodexHostEnvironment(config: CodexConfig): Record<string, string> {
  const apiKey = config.openAiApiKey();
  const baseUrl = config.openAiBaseUrl();
  return {
    ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
    ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
    CODEX_HOME: config.home(),
  };
}

function codexProviderIdForEndpoint(endpointId: string): string {
  return `garcon_${endpointId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function codexApiKeyEnvForEndpoint(endpointId: string): string {
  return `GARCON_CODEX_PROVIDER_API_KEY_${endpointId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
