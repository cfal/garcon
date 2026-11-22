import { describe, expect, it } from 'bun:test';
import { mkdtempDisposable, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { CodexAppServerClient } from '../../../server-agents/codex/src/agents/codex/app-server/client.js';
import integrationPackage from '../../package.json' with { type: 'json' };
import { CODEX_BINARY } from '../../support/pinned-agent-binaries.js';
import { rejectionOf } from '../../support/promise-assertions.js';

describe('pinned Codex history API compatibility', () => {
  it('connects and handles a history request after Codex is installed on the service PATH', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'garcon-codex-handshake-'));
    const home = await realpath(directory.path);
    const installed = join(home, 'bin');
    const node = Bun.which('node');
    if (!node) throw new Error('The pinned Codex CLI requires Node.');
    await symlink(node, join(home, basename(node)));
    const client = new CodexAppServerClient({
      env: { GARCON_CODEX_CLI: '', PATH: [installed, home].join(delimiter), CODEX_HOME: home, HOME: home },
      shutdownGraceMs: 100,
    });
    try {
      // Prevents background marketplace fetches from outliving the fixture.
      // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core-plugins/src/manager.rs#L2824-L2834
      await writeFile(join(home, 'config.toml'), '[features]\nplugins = false\n');
      expect(await rejectionOf(client.connect())).toMatchObject({ code: 'ENOENT' });
      await symlink(dirname(CODEX_BINARY), installed, 'junction');
      const initialized = await client.connect();
      expect(initialized.userAgent.split(' ')[0]).toEndWith(`/${integrationPackage.devDependencies['@openai/codex']}`);
      expect(initialized.codexHome).toBe(home);

      const threadId = '00000000-0000-0000-0000-000000000000';
      const failure = await rejectionOf(client.listThreadTurns({ threadId, limit: 1, sortDirection: 'asc', itemsView: 'full' }));
      expect(failure).toMatchObject({ code: -32600, message: expect.stringContaining(threadId) });
    } finally {
      await client.shutdown();
    }
  });
});
