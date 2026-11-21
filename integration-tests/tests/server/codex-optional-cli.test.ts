import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('an executor without Codex can report auth and readiness, then detect a new installation', async () => {
  await withIntegrationFixture('codex-optional-cli', async ({ client, executionDirs }) => {
    const query = new URLSearchParams({ executorId: client.executorId });
    const auth = () => client.get(`/api/v1/agents/auth?agent=codex&${query}`);
    expect(await auth()).toMatchObject({
      codex: { authenticated: false, canReauth: false, source: 'none', detail: expect.stringContaining('GARCON_CODEX_CLI') },
    });
    expect(await client.get(`/api/v1/agents/readiness?${query}`)).toMatchObject({
      codex: { nativeReady: false }, shell: { ready: true },
    });

    await writeFile(join(executionDirs.home, 'codex'), '#!/bin/sh\necho "Not logged in" >&2\nexit 1\n', { mode: 0o755 });
    expect(await auth()).toMatchObject({ codex: { authenticated: false, canReauth: true } });
  }, { resolveServerEnvironment: ({ home }) => ({ GARCON_CODEX_CLI: join(home, 'codex') }) });
}, 30_000);
