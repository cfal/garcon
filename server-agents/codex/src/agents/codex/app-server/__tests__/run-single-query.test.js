import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { resolveCodexCli } from '../cli.js';
import { runSingleQuery } from '../run-single-query.js';

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

  it('sandboxes every one-shot read-only regardless of permission mode', async () => {
    // One-shot callers only turn text into text. The compaction prompt carries
    // archived transcript content that is not trusted, so inheriting the chat's
    // workspace-write default would let that text modify the project.
    for (const permissionMode of ['default', 'acceptEdits', 'bypassPermissions']) {
      spawnMock.mockClear();
      await runSingleQuery('hello', { permissionMode, projectPath: '/workspace' });
      const args = spawnMock.mock.calls[0][0];
      expect(args[args.indexOf('--sandbox') + 1], permissionMode).toBe('read-only');
      expect(args).not.toContain('danger-full-access');
      expect(args).not.toContain('workspace-write');
    }
  });

  it('passes custom provider config and API key env to codex exec', async () => {
    const expectedCodexCommand = resolveCodexCli().command;

    await runSingleQuery('hello', {
      model: 'acme-code',
      codexConfig: {
        modelCatalogPath: '/opt/garcon/codex-models.json',
        config: {
          service_tier: 'ultrafast',
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
    expect(command).toContain('service_tier="ultrafast"');
    expect(command.slice(-3)).toEqual(['--config', 'service_tier="default"', '-']);
    expect(command).toContain('model_catalog_json="/opt/garcon/codex-models.json"');
    expect(command).toContain('model_provider="garcon_acme_openai"');
    expect(Bun.TOML.parse(command.find((arg) => arg.startsWith('model_providers=')))).toEqual({
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
    });
    expect(options.env.GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI).toBe('secret');
  });

  it('omits reasoning effort for provider default thinking', async () => {
    await runSingleQuery('hello', {
      thinkingMode: 'none',
    });

    const [command] = spawnMock.mock.calls[0];
    expect(command).not.toContain('model_reasoning_effort="low"');
    expect(command).not.toContain('model_reasoning_effort="none"');
  });

  it('preserves max reasoning effort for codex exec', async () => {
    await runSingleQuery('hello', {
      thinkingMode: 'max',
    });

    const [command] = spawnMock.mock.calls[0];
    expect(command).toContain('model_reasoning_effort="max"');
    expect(command).not.toContain('model_reasoning_effort="xhigh"');
  });

  it('honors an explicit codex CLI override', async () => {
    process.env.GARCON_CODEX_CLI = '/custom/codex';

    await runSingleQuery('hello', { projectPath: '/workspace' });
    expect(spawnMock.mock.calls[0][0][0]).toBe('/custom/codex');
  });
});
