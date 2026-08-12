import { describe, expect, it } from 'bun:test';
import { runProjectionConformance } from '@garcon/server-agent-common/transcript-projection/testing';

// Certifies the shared journal engine upholds INV-5 identity, canonical
// item/subrow expansion, restart parity, and byte-identical serving under the
// OpenCode native namespace. OpenCode's part-id source attachment and provider
// error binding stay covered by its own converter tests.
describe('opencode projection conformance', () => {
  it('upholds the shared journal identity contract', async () => {
    await expect(runProjectionConformance({ ownerId: 'opencode' })).resolves.toBeUndefined();
  });
});
