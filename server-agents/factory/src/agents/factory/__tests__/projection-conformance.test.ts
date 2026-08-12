import { describe, expect, it } from 'bun:test';
import { runProjectionConformance } from '@garcon/server-agent-common/transcript-projection/testing';

// Certifies the shared journal engine upholds INV-5 identity, canonical
// item/subrow expansion, restart parity, and byte-identical serving under the
// Factory native namespace. Factory is a shared-engine best-effort
// integration; this proves the engine never collapses equal content or mutates
// a committed envelope for it.
describe('factory projection conformance', () => {
  it('upholds the shared journal identity contract', async () => {
    await expect(runProjectionConformance({ ownerId: 'factory' })).resolves.toBeUndefined();
  });
});
