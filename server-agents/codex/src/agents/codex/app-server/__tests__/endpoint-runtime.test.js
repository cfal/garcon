import { describe, expect, it } from 'bun:test';
import { buildCodexAppServerEndpointRuntime } from '../endpoint-runtime.ts';

function selection(endpoint = {}) {
  return {
    model: 'acme-code',
    apiProviderId: 'acme',
    modelEndpointId: 'acme_openai',
    modelProtocol: 'openai-compatible',
    isLocal: false,
    apiProvider: { id: 'acme', label: 'Acme', endpoints: [] },
    endpoint: {
      id: 'acme_openai',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.acme.test/v1',
      apiKey: 'secret',
      capabilities: { responses: true },
      defaultModel: 'acme-code',
      models: [],
      supportsImages: false,
      modelDiscovery: 'openai-models',
      headers: {
        'HTTP-Referer': 'https://github.com/cfal/garcon',
        'X-OpenRouter-Title': 'Garcon',
      },
      ...endpoint,
    },
  };
}

describe('buildCodexAppServerEndpointRuntime', () => {
  it('builds Codex Responses provider config for compatible endpoints', () => {
    expect(buildCodexAppServerEndpointRuntime(selection())).toEqual({
      codexConfig: {
        config: {
          model_provider: 'garcon_acme_openai',
          model_providers: {
            garcon_acme_openai: {
              name: 'Acme',
              base_url: 'https://api.acme.test/v1',
              wire_api: 'responses',
              requires_openai_auth: false,
              supports_websockets: false,
              env_key: 'GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI',
              http_headers: {
                'HTTP-Referer': 'https://github.com/cfal/garcon',
                'X-OpenRouter-Title': 'Garcon',
              },
            },
          },
        },
        env: {
          GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI: 'secret',
        },
      },
    });
  });

  it('omits API key env config for blank-key endpoints', () => {
    expect(buildCodexAppServerEndpointRuntime(selection({ apiKey: '', headers: undefined }))).toEqual({
      codexConfig: {
        config: {
          model_provider: 'garcon_acme_openai',
          model_providers: {
            garcon_acme_openai: {
              name: 'Acme',
              base_url: 'https://api.acme.test/v1',
              wire_api: 'responses',
              requires_openai_auth: false,
              supports_websockets: false,
            },
          },
        },
      },
    });
  });
});
