import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSensitiveValuesNotPersisted } from '../../support/integration-fixture.js';
import {
  liveCodexForkRunRequest,
  liveCodexRunRequest,
  liveCodexStartRequest,
  startLiveCodexTestEnvironment,
} from '../../support/live-codex.js';

const environmentNames = ['CODEX_TESTING_KEY', 'CLAUDE_TESTING_KEY', 'CODEX_TESTING_BASE_URL', 'CODEX_TESTING_MODEL'];
const savedEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.CODEX_TESTING_KEY = 'synthetic-testing-key';
  process.env.CLAUDE_TESTING_KEY = 'synthetic-unused-claude-key';
  process.env.CODEX_TESTING_BASE_URL = 'https://model.invalid/v1';
  process.env.CODEX_TESTING_MODEL = 'integration-live-model';
});

afterEach(() => {
  for (const name of environmentNames) {
    const value = savedEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('live Codex credential proxy', () => {
  test.each(['CODEX_TESTING_KEY', 'CODEX_TESTING_BASE_URL', 'CODEX_TESTING_MODEL'])(
    'requires explicit %s without falling back to another lane', async (name) => {
      delete process.env[name];
      await expect(startLiveCodexTestEnvironment()).rejects.toThrow(
        `${name} is required for live Codex integration tests.`,
      );
    },
  );

  test('does not expose a malformed private endpoint in errors', async () => {
    process.env.CODEX_TESTING_BASE_URL = 'private-invalid-endpoint';
    await expect(startLiveCodexTestEnvironment()).rejects.toThrow(
      'CODEX_TESTING_BASE_URL must be an HTTP(S) API base URL.',
    );
  });

  test('uses the configured model for live starts, continuations, and forks', () => {
    const input = { chatId: '1783725900000001', command: 'Synthetic prompt' };
    const requests = [
      liveCodexStartRequest({ ...input, projectPath: '/synthetic/project' }),
      liveCodexRunRequest(input),
      liveCodexForkRunRequest({ ...input, sourceChatId: '1783725900000000' }),
    ];
    for (const request of requests) {
      expect(request.model).toBe('integration-live-model');
      expect(request.thinkingMode).toBe('low');
    }
  });

  test.each(['/v1', '/nested/v1/'])('uses the configured %s base path without persisting credentials', async (basePath) => {
    const testingKey = `garcon-live-proxy-test-${crypto.randomUUID()}`;
    let authorization: string | null = null;
    let upstreamPath: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        upstreamPath = new URL(request.url).pathname;
        return Response.json({ forwarded: true });
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'garcon-live-codex-proxy-test-'));
    process.env.CODEX_TESTING_KEY = testingKey;
    process.env.CODEX_TESTING_BASE_URL = `http://127.0.0.1:${upstream.port}${basePath}`;

    try {
      const environment = await startLiveCodexTestEnvironment();
      try {
        expect(JSON.stringify(environment.serverEnvironment)).not.toContain(testingKey);
        const directories = {
          root,
          config: join(root, 'config'),
          workspace: join(root, 'workspace'),
          project: join(root, 'project'),
          home: join(root, 'home'),
        };
        await Promise.all(Object.values(directories).map((directory) =>
          mkdir(directory, { recursive: true })));
        await environment.prepareWorkspace(directories);
        const catalog = JSON.parse(await readFile(join(directories.home, '.codex/live-models.json'), 'utf8'));
        expect(catalog.models).toMatchObject([{
          slug: 'integration-live-model',
          display_name: 'Integration test model',
          default_reasoning_level: 'low',
          context_window: 272_000,
          supports_reasoning_summaries: false,
        }]);
        const config = Bun.TOML.parse(await readFile(join(directories.home, '.codex/config.toml'), 'utf8'));
        expect(config).toMatchObject({
          model_provider: 'garcon-live-testing',
          web_search: 'disabled',
          model_providers: {
            'garcon-live-testing': {
              base_url: `${environment.proxyBaseUrl}/v1`,
              wire_api: 'responses',
            },
          },
        });
        await assertSensitiveValuesNotPersisted({
          directory: root,
          diagnostics: environment.serverEnvironment,
          values: [testingKey],
        });

        const response = await fetch(`${environment.proxyBaseUrl}/v1/responses`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer placeholder',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: 'test' }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ forwarded: true });
        expect(String(authorization)).toBe(`Bearer ${testingKey}`);
        expect(String(upstreamPath)).toBe(`${basePath.replace(/\/$/, '')}/responses`);
      } finally {
        await environment.dispose();
      }
    } finally {
      upstream.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});
