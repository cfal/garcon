import { describe, expect, it } from 'bun:test';
import { runProjectionConformance } from '@garcon/server-agent-common/transcript-projection/testing';

// Certifies the shared journal engine upholds INV-5 identity, canonical
// item/subrow expansion, restart parity, and byte-identical serving under the
// direct Responses native namespace. The direct store already persists
// complete rendered messages; this proves the engine preserves their identity.
describe('direct-openai-responses-compatible projection conformance', () => {
  it('upholds the shared journal identity contract', async () => {
    await expect(
      runProjectionConformance({ ownerId: 'direct-openai-responses-compatible' }),
    ).resolves.toBeUndefined();
  });
});
