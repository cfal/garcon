import { describe, expect, it } from 'bun:test';
import { runProjectionConformance } from '@garcon/server-agent-common/transcript-projection/testing';

// Certifies the shared journal engine upholds INV-5 identity, canonical
// item/subrow expansion, restart parity, and byte-identical serving under the
// Pi native namespace. Pi's occurrence-ordinal identity and settlement
// aliasing stay covered by its own runtime and settlement tests.
describe('pi projection conformance', () => {
  it('upholds the shared journal identity contract', async () => {
    await expect(runProjectionConformance({ ownerId: 'pi' })).resolves.toBeUndefined();
  });
});
