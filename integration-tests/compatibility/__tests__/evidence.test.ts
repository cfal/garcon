import { expect, mock, test } from 'bun:test';
import { CompatibilityEvidence } from '../../support/compatibility-evidence.js';

const missing = { surface: 'executor', name: 'files.read', version: 1 } as const;
const list = { surface: 'executor', name: 'files.list', version: 1 } as const;
const catalogs = { executor: { 'files.read': [2], 'files.list': [1] }, 'direct-cli': {}, 'gateway-cli': {} };

test('absence requires an exact declared contract and an executed refusal check', async () => {
  const evidence = new CompatibilityEvidence(catalogs, [{ workflow: 'read', missing: [missing] }]);
  const read = mock(async () => {});
  const refusal = mock(async () => {});
  const listing = mock(async () => {});
  await evidence.check('read', [missing], read, refusal);
  await evidence.check('list', [list], listing, refusal);
  expect(read).not.toHaveBeenCalled();
  expect(refusal).toHaveBeenCalledTimes(1);
  expect(refusal).toHaveBeenCalledWith([missing]);
  expect(listing).toHaveBeenCalledTimes(1);
  expect(evidence.report()).toEqual({ checked: ['list'], unsupported: [{ workflow: 'read', missing: [missing] }], contracts: catalogs });
});

test('unexpected absence, false unsupported expectations, and untested expectations fail closed', async () => {
  const run = mock(async () => {});
  await expect(new CompatibilityEvidence(catalogs, []).check('read', [missing], run, run)).rejects.toThrow('Unexpected contract availability');
  const falseExpectation = new CompatibilityEvidence(catalogs, [{ workflow: 'list', missing: [list] }]);
  await expect(falseExpectation.check('list', [list], run, run)).rejects.toThrow('Unexpected contract availability');
  expect(() => falseExpectation.report()).toThrow('Unverified');
  expect(() => new CompatibilityEvidence(catalogs, [{ workflow: 'read', missing: [missing] }]).report()).toThrow('Unverified');
  expect(run).not.toHaveBeenCalled();
});

test('an unproved refusal is never reported as a skipped success', async () => {
  const evidence = new CompatibilityEvidence(catalogs, [{ workflow: 'read', missing: [missing] }]);
  await expect(evidence.check('read', [missing], async () => {}, async () => { throw new Error('Not a definite refusal'); })).rejects.toThrow('Not a definite refusal');
  expect(evidence.unsupported).toEqual([]);
  expect(() => evidence.report()).toThrow('Unverified');
});
