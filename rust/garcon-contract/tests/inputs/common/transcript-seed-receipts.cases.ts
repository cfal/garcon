import { expect, test } from 'bun:test';
import {
  createNativeSeedReceipt, parseNativeSeedReceipt, receiptForCarriedContext, retargetNativeSeedReceipt,
} from '../../../../../common/transcript-seed.ts';

test('builds and parses exact receipt fields', () => {
  const receipt = createNativeSeedReceipt({ agentSessionId: 'fixture-session', placement: 'user-prefix', prefix: 'a\u{1f642}' });
  expect(receipt.codeUnitLength).toBe(3);
  expect(receipt.format).toBe('v3-xml');
  expect(parseNativeSeedReceipt(receipt)).toEqual(receipt);
  for (const patch of [
    { agentSessionId: '' }, { placement: 'history' }, { format: 'legacy' },
    { codeUnitLength: -1 }, { codeUnitLength: 0.5 }, { codeUnitLength: 2 ** 53 },
    { sha256: receipt.sha256.toUpperCase() }, { sha256: receipt.sha256 + '\n' },
  ]) expect(parseNativeSeedReceipt({ ...receipt, ...patch })).toBeNull();
  expect(parseNativeSeedReceipt({ ...receipt, codeUnitLength: 2 ** 53 - 1, ignored: true }))
    .toEqual({ ...receipt, codeUnitLength: 2 ** 53 - 1 });
  expect(parseNativeSeedReceipt(null)).toBeNull();
});

test('keeps the receipt hash while changing the selected session', () => {
  const receipt = createNativeSeedReceipt({ agentSessionId: 'source', placement: 'provider-context', prefix: 'a', format: 'legacy-v0' });
  expect(retargetNativeSeedReceipt(receipt, 'target')).toEqual({ ...receipt, agentSessionId: 'target' });
  expect(retargetNativeSeedReceipt(null, '')).toBeNull();
  expect(() => retargetNativeSeedReceipt(receipt, '')).toThrow('Native seed receipt session ID is required');
});

test('derives a receipt only from an actual carried context', () => {
  expect(receiptForCarriedContext(null, '')).toBeNull();
  expect(receiptForCarriedContext({ prefix: 'Synthetic' }, 'fixture-session')?.placement).toBe('user-prefix');
  expect(receiptForCarriedContext({ prefix: 'Synthetic', summaryTruncated: true }, 'fixture-session', 'provider-context')?.placement)
    .toBe('provider-context');
  expect(() => receiptForCarriedContext({ prefix: '' }, '')).toThrow('Native seed receipt session ID is required');
});

test('hashes UTF-8 even when the UTF-16 source has a lone surrogate', () => {
  const common = { agentSessionId: 'fixture-session', placement: 'user-prefix' } as const;
  expect(createNativeSeedReceipt({ ...common, prefix: '\ud800' }))
    .toEqual(createNativeSeedReceipt({ ...common, prefix: '\ufffd' }));
});
