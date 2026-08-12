import { describe, expect, it } from 'bun:test';
import { runProjectionConformance } from '../testing.js';

// Proves the reusable projection conformance kit itself upholds the shared
// engine's INV-5 identity contract. Each integration wires the same entry
// point with its own owner id; this exercises it under a neutral namespace so
// a regression in the engine surfaces here before any provider suite runs.
describe('runProjectionConformance', () => {
  it('passes the shared journal engine under a neutral owner namespace', async () => {
    await expect(runProjectionConformance({ ownerId: 'conformance' })).resolves.toBeUndefined();
  });
});
