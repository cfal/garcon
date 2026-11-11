import { describe, expect, it } from 'bun:test';
import {
  buildCodexAppServerEndpointRuntime,
  buildCodexHostEnvironment,
  buildCodexHostProviderConfig,
} from '../endpoint-runtime.ts';
import { resolveCodexModelCatalogPath } from '../model-catalog.ts';
import { appendCodexConfigArgs } from '../config-overrides.ts';

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
              env_http_headers: {
                'HTTP-Referer': 'GARCON_CODEX_PROVIDER_HEADER_0_ACME_OPENAI',
                'X-OpenRouter-Title': 'GARCON_CODEX_PROVIDER_HEADER_1_ACME_OPENAI',
              },
            },
          },
        },
        env: {
          GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI: 'secret',
          GARCON_CODEX_PROVIDER_HEADER_0_ACME_OPENAI: 'https://github.com/cfal/garcon',
          GARCON_CODEX_PROVIDER_HEADER_1_ACME_OPENAI: 'Garcon',
        },
        modelCatalogPath: resolveCodexModelCatalogPath(),
      },
    });
  });

  it('keeps header values out of argv and preserves literal dotted header names', () => {
    const runtime = buildCodexAppServerEndpointRuntime({
      ...selection({ headers: { 'X.Gateway.Key': 'synthetic-header-secret', 'X-Gateway-Key': 'other-secret' } }),
      credential: null,
    });
    const args = [];
    appendCodexConfigArgs(args, runtime.codexConfig.config);
    expect(Bun.TOML.parse(args.find((arg) => arg.startsWith('model_providers=')))).toEqual({
      model_providers: {
        garcon_acme_openai: expect.objectContaining({
          env_http_headers: {
            'X.Gateway.Key': 'GARCON_CODEX_PROVIDER_HEADER_0_ACME_OPENAI',
            'X-Gateway-Key': 'GARCON_CODEX_PROVIDER_HEADER_1_ACME_OPENAI',
          },
        }),
      },
    });
    expect(runtime.codexConfig.env).toEqual({
      GARCON_CODEX_PROVIDER_HEADER_0_ACME_OPENAI: 'synthetic-header-secret',
      GARCON_CODEX_PROVIDER_HEADER_1_ACME_OPENAI: 'other-secret',
    });
    expect(args.join(' ')).not.toContain('synthetic-header-secret');
    expect(args.join(' ')).not.toContain('other-secret');
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

  it('preserves blank header values that Codex omits from env_http_headers', () => {
    const runtime = buildCodexAppServerEndpointRuntime({
      ...selection({ headers: { 'X.Empty.Header': '', 'X-Blank': '  ', 'X-Key': 'synthetic-secret' } }),
      credential: null,
    });
    const provider = runtime.codexConfig.config.model_providers.garcon_acme_openai;
    expect(provider.http_headers).toEqual({ 'X.Empty.Header': '', 'X-Blank': '  ' });
    expect(provider.env_http_headers).toEqual({ 'X-Key': 'GARCON_CODEX_PROVIDER_HEADER_2_ACME_OPENAI' });
    expect(runtime.codexConfig.env).toEqual({ GARCON_CODEX_PROVIDER_HEADER_2_ACME_OPENAI: 'synthetic-secret' });
    const args = [];
    appendCodexConfigArgs(args, runtime.codexConfig.config);
    expect(Bun.TOML.parse(args.find((arg) => arg.startsWith('model_providers='))).model_providers.garcon_acme_openai.http_headers)
      .toEqual({ 'X.Empty.Header': '', 'X-Blank': '  ' });
    expect(args.join(' ')).not.toContain('synthetic-secret');
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
