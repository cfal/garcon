import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSensitiveValuesNotPersisted } from '../../support/integration-fixture.js';
import { startLiveCodexTestEnvironment } from '../../support/live-codex.js';

describe('live Codex credential proxy', () => {
  test('keeps the provider credential out of Codex files and environment', async () => {
    const previousTestingKey = process.env.OPENAI_TESTING_KEY;
    const testingKey = `garcon-live-proxy-test-${crypto.randomUUID()}`;
    let authorization: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        return Response.json({ forwarded: true });
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'garcon-live-codex-proxy-test-'));
    process.env.OPENAI_TESTING_KEY = testingKey;

    try {
      const environment = await startLiveCodexTestEnvironment({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/responses`,
      });
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
      } finally {
        await environment.dispose();
      }
    } finally {
      if (previousTestingKey === undefined) {
        delete process.env.OPENAI_TESTING_KEY;
      } else {
        process.env.OPENAI_TESTING_KEY = previousTestingKey;
      }
      upstream.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});
