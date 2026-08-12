import { describe, expect, it } from 'bun:test';
import { runProjectionConformance } from '@garcon/server-agent-common/transcript-projection/testing';

// Certifies the shared journal engine upholds INV-5 identity, canonical
// item/subrow expansion, restart parity, and byte-identical serving under the
// Cursor native namespace. Cursor is unit-only with no scripted-model tier, so
// this deterministic engine conformance is its projection-identity coverage.
describe('cursor projection conformance', () => {
  it('upholds the shared journal identity contract', async () => {
    await expect(runProjectionConformance({ ownerId: 'cursor' })).resolves.toBeUndefined();
  });
});
