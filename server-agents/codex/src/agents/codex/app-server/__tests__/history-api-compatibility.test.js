import { describe, expect, it } from 'bun:test';
import { CodexAppServerClient, CodexAppServerRpcError } from '../client.ts';

describe('bundled Codex history API compatibility', () => {
  it('recognizes thread/turns/list as a public method', async () => {
    const client = new CodexAppServerClient();
    try {
      const initialized = await client.connect();
      expect(initialized.userAgent).toBeString();
      expect(initialized.userAgent.length).toBeGreaterThan(0);

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
    } finally {
      client.shutdown();
    }
  });
});
