import { describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient, CodexAppServerRpcError } from '../client.ts';

describe('bundled Codex history API compatibility', () => {
  it('recognizes paginated turn and item list methods', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'garcon-codex-handshake-')));
    const client = new CodexAppServerClient({
      env: { CODEX_HOME: home, HOME: home },
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

      let failure;
      try {
        await client.listThreadTurns({
          threadId: '00000000-0000-0000-0000-000000000000',
          limit: 1,
          sortDirection: 'asc',
          itemsView: 'full',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexAppServerRpcError);
      expect(failure.code).not.toBe(-32601);

      failure = undefined;
      try {
        await client.listThreadItems({
          threadId: '00000000-0000-0000-0000-000000000000',
          limit: 1,
          sortDirection: 'asc',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexAppServerRpcError);
      expect(failure.message).not.toMatch(/^method not found$/i);
    } finally {
      try {
        await client.shutdown();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });
});
