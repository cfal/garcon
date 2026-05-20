import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { resolveCodexCliCommand, runSingleQuery } from '../codex-app-server/run-single-query.js';

const originalSpawn = Bun.spawn;
let spawnMock;

function textStream(text) {
  return new Response(text).body;
}

describe('Codex runSingleQuery', () => {
  beforeEach(() => {
    spawnMock = mock(() => ({
      stdout: textStream('codex output'),
      stderr: textStream(''),
      exited: Promise.resolve(0),
    }));
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  it('passes custom provider config and API key env to codex exec', async () => {
    const expectedCodexCommand = await resolveCodexCliCommand();

    await runSingleQuery('hello', {
      model: 'acme-code',
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
            },
          },
        },
        env: {
          GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI: 'secret',
        },
      },
    });

    const [command, options] = spawnMock.mock.calls[0];
    expect(command[0]).toBe(expectedCodexCommand);
    expect(command).toContain('--config');
    expect(command).toContain('model_provider="garcon_acme_openai"');
    expect(command).toContain('model_providers.garcon_acme_openai.base_url="https://api.acme.test/v1"');
    expect(command).toContain('model_providers.garcon_acme_openai.wire_api="responses"');
    expect(command).toContain('model_providers.garcon_acme_openai.requires_openai_auth=false');
    expect(command).toContain('model_providers.garcon_acme_openai.supports_websockets=false');
    expect(command).toContain('model_providers.garcon_acme_openai.env_key="GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI"');
    expect(options.env.GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI).toBe('secret');
  });

  it('resolves codex from PATH', async () => {
    expect(await resolveCodexCliCommand()).toBe('codex');
  });
});
