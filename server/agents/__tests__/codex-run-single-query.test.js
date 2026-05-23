import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { resolveCodexCli } from '../codex/app-server/cli.js';
import { resolveCodexCliCommand, runSingleQuery } from '../codex/app-server/run-single-query.js';

const originalSpawn = Bun.spawn;
const originalCodexCli = process.env.GARCON_CODEX_CLI;
let spawnMock;

function textStream(text) {
  return new Response(text).body;
}

describe('Codex runSingleQuery', () => {
  beforeEach(() => {
    delete process.env.GARCON_CODEX_CLI;
    spawnMock = mock(() => ({
      stdout: textStream('codex output'),
      stderr: textStream(''),
      exited: Promise.resolve(0),
    }));
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    if (originalCodexCli === undefined) {
      delete process.env.GARCON_CODEX_CLI;
    } else {
      process.env.GARCON_CODEX_CLI = originalCodexCli;
    }
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

  it('honors an explicit codex CLI override', async () => {
    process.env.GARCON_CODEX_CLI = '/custom/codex';

    expect(await resolveCodexCliCommand()).toBe('/custom/codex');
  });

  it('prefers the bundled codex CLI before PATH fallback', async () => {
    await expect(resolveCodexCli({
      env: {},
      bundledCommand: '/repo/server/node_modules/.bin/codex',
      isExecutable: async () => true,
    })).resolves.toEqual({
      command: '/repo/server/node_modules/.bin/codex',
      source: 'bundled',
    });

    await expect(resolveCodexCli({
      env: {},
      bundledCommand: '/repo/server/node_modules/.bin/codex',
      isExecutable: async () => false,
    })).resolves.toEqual({
      command: 'codex',
      source: 'path',
    });
  });
});
