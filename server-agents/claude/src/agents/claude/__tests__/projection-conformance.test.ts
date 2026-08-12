import { describe, expect, it } from 'bun:test';
import { runProjectionConformance } from '@garcon/server-agent-common/transcript-projection/testing';

// Certifies that the shared journal engine upholds INV-5 identity, canonical
// item/subrow expansion, restart parity, and byte-identical serving under the
// Claude native namespace. Claude's converter identity attachment stays
// covered by its own converter tests.
describe('claude projection conformance', () => {
  it('upholds the shared journal identity contract', async () => {
    await expect(runProjectionConformance({ ownerId: 'claude' })).resolves.toBeUndefined();
  });
});
