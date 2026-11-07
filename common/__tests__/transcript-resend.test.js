import { expect, test } from 'bun:test';
import { parseResendSnapshot, parseResendSnapshotRequest } from '../transcript-display-auxiliary.js';

const identity = { serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view' };
const snapshot = { ...identity, sourceHead: 1500, processingPhase: null,
  candidates: Array.from({ length: 1500 }, (_, index) => ({ ordinal: index + 1,
    content: `Synthetic input ${index} ${'x'.repeat(600)}`, attachmentNames: ['synthetic.txt'] })) };

test('parses a complete ascending resend snapshot without a count or text cap', () => {
  expect(parseResendSnapshotRequest(identity)).toEqual(identity);
  expect(parseResendSnapshot(snapshot)).toEqual(snapshot);
  expect(parseResendSnapshot({ ...snapshot, sourceHead: 0, candidates: [] }).candidates).toEqual([]);
});

test('distinguishes processing suppression from a successful idle empty list', () => {
  expect(parseResendSnapshot({ ...snapshot, processingPhase: 'running', candidates: [] }).processingPhase).toBe('running');
  expect(() => parseResendSnapshot({ ...snapshot, processingPhase: 'running' })).toThrow();
  expect(() => parseResendSnapshot({ ...snapshot, processingPhase: 'unknown' })).toThrow();
});

test('rejects invalid identities, candidate order, source boundaries, and attachments', () => {
  const candidate = snapshot.candidates[0];
  for (const malformed of [
    { ...snapshot, serverInstanceId: '' }, { ...snapshot, transcriptViewId: '' },
    { ...snapshot, sourceHead: 1499 }, { ...snapshot, candidates: [candidate, candidate] },
    { ...snapshot, candidates: [...snapshot.candidates].reverse() },
    { ...snapshot, candidates: [{ ...candidate, ordinal: 0 }] },
    { ...snapshot, candidates: [{ ...candidate, attachmentNames: [1] }] },
  ]) expect(() => parseResendSnapshot(malformed)).toThrow();
});
