import { describe, expect, it } from 'bun:test';
import { mkdtempDisposable, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient, CodexAppServerRpcError } from '../../../server-agents/codex/src/agents/codex/app-server/client.js';
import { CODEX_BINARY } from '../../support/live-codex.js';
import { rejectionOf } from '../../support/promise-assertions.js';

async function rpcFailure(request: Promise<unknown>): Promise<CodexAppServerRpcError> {
  const failure = await rejectionOf(request);
  if (!(failure instanceof CodexAppServerRpcError)) throw new Error('Expected a Codex RPC failure', { cause: failure });
  return failure;
}

describe('pinned Codex history API compatibility', () => {
  it('recognizes paginated turn and item list methods', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'garcon-codex-handshake-'));
    const home = await realpath(directory.path);
    const client = new CodexAppServerClient({
      env: { GARCON_CODEX_CLI: CODEX_BINARY, CODEX_HOME: home, HOME: home },
      shutdownGraceMs: 100,
    });
    try {
      // Prevents background marketplace fetches from outliving the fixture.
      // https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core-plugins/src/manager.rs#L2824-L2834
      await writeFile(join(home, 'config.toml'), '[features]\nplugins = false\n');
      const initialized = await client.connect();
      expect(initialized.userAgent).toBeString();
      expect(initialized.userAgent.length).toBeGreaterThan(0);
      expect(initialized.codexHome).toBe(home);

      const page = { threadId: '00000000-0000-0000-0000-000000000000', limit: 1, sortDirection: 'asc' } as const;
      const turnsError = await rpcFailure(client.listThreadTurns({ ...page, itemsView: 'full' }));
      expect(turnsError.code).not.toBe(-32601);

      const itemsError = await rpcFailure(client.listThreadItems(page));
      expect(itemsError.message).not.toMatch(/^method not found$/i);
    } finally {
      await client.shutdown();
    }
  });
});
