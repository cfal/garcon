import { describe, expect, it } from 'bun:test';
import {
  buildCodexAppServerEndpointRuntime,
  buildCodexHostEnvironment,
  buildCodexHostProviderConfig,
} from '../endpoint-runtime.ts';
import { resolveCodexModelCatalogPath } from '../model-catalog.ts';

function selection(endpoint = {}) {
  return {
    selection: {
      apiProviderId: 'acme',
      endpointId: 'acme_openai',
      providerLabel: 'Acme',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.acme.test/v1',
      capabilities: { responses: true },
      model: 'acme-code',
      isLocal: false,
      credential: null,
      headers: {
        'HTTP-Referer': 'https://github.com/cfal/garcon',
        'X-OpenRouter-Title': 'Garcon',
      },
      ...endpoint,
    },
    credential: 'secret',
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
        modelCatalogPath: resolveCodexModelCatalogPath(),
      },
    });
  });

  it('omits API key env config for blank-key endpoints', () => {
    expect(buildCodexAppServerEndpointRuntime({
      ...selection({ headers: {} }),
      credential: null,
    })).toEqual({
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
        modelCatalogPath: resolveCodexModelCatalogPath(),
      },
    });
  });

  it('supplies the bundled catalog only when effective auth disables live discovery', () => {
    expect(buildCodexHostProviderConfig({ kind: 'chatgpt' })).toBeUndefined();
    expect(buildCodexHostProviderConfig({ kind: 'none' })).toBeUndefined();
    expect(buildCodexHostProviderConfig({ kind: 'api-key' })).toEqual({
      config: {},
      modelCatalogPath: resolveCodexModelCatalogPath(),
    });
    expect(buildCodexHostProviderConfig({ kind: 'external' })).toEqual({
      config: {},
      modelCatalogPath: resolveCodexModelCatalogPath(),
    });
  });

  it('passes both supported host API-key variables to Codex processes', () => {
    expect(buildCodexHostEnvironment({
      codexApiKey: () => 'codex-key',
      openAiApiKey: () => 'openai-key',
      openAiBaseUrl: () => null,
      home: () => '/home/test/.codex',
      packageVersion: () => 'test',
    })).toEqual({
      CODEX_API_KEY: 'codex-key',
      OPENAI_API_KEY: 'openai-key',
      CODEX_HOME: '/home/test/.codex',
    });
  });
});
