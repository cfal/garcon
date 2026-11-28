import { expect, test } from 'bun:test';
import { isCarryOverSegmentId, parseCarryOverSegmentIndex } from '../../../../server/controller/chats/carryover/segment-types.ts';

const id = '12345678-1234-4123-8123-123456789abc';
const other = '12345678-1234-4123-8123-123456789abd';
const page = {
  file: 'pages/000000.json.br', firstSequence: 0, messageCount: 2, uncompressedBytes: 4,
  compressedBytes: 5, sha256: 'a'.repeat(64),
};
const manifest = {
  version: 1, messageSchemaVersion: 1, id, seedSanitation: 'stripped-exact',
  messageCount: 2, canonicalMessagesSha256: 'b'.repeat(64), pages: [page],
};

test('normalizes a canonical manifest without preserving unknown fields', () => {
  expect(parseCarryOverSegmentIndex({ ...manifest, extra: true }, id)).toEqual(manifest);
  expect(parseCarryOverSegmentIndex({ ...manifest, seedSanitation: 'absent', pages: [
    { ...page, messageCount: 1, firstSequence: -0 },
    { ...page, file: 'pages/000001.json.br', messageCount: 1, firstSequence: 1 },
  ] }).seedSanitation).toBe('absent');
  expect(isCarryOverSegmentId(id)).toBe(true);
  expect(isCarryOverSegmentId(id.toUpperCase())).toBe(false);
  expect(isCarryOverSegmentId('12345678-1234-6123-0123-123456789abc')).toBe(false);
});

test('rejects wrong versions, scope, paths, hashes and page ranges in validation order', () => {
  for (const [value, message] of [
    [[], 'Carryover segment index must be an object'],
    [{ ...manifest, version: 2, messageSchemaVersion: 2 }, 'Unsupported carryover segment version'],
    [{ ...manifest, messageSchemaVersion: '1' }, 'Unsupported carryover message schema version'],
    [{ ...manifest, id: id.toUpperCase() }, 'Invalid carryover segment ID'],
    [{ ...manifest, messageCount: 9_007_199_254_740_992 }, 'Invalid carryover message count'],
    [{ ...manifest, messageCount: 0 }, 'Invalid carryover message count'],
    [{ ...manifest, canonicalMessagesSha256: 'B'.repeat(64) }, 'Invalid carryover canonical digest'],
    [{ ...manifest, pages: [] }, 'Carryover segment has no pages'],
    [{ ...manifest, pages: [null] }, 'Invalid carryover page descriptor'],
    [{ ...manifest, pages: [{ ...page, file: 'pages/../different.json.br' }] }, 'Unsafe or noncanonical carryover page path'],
    [{ ...manifest, pages: [{ ...page, firstSequence: -1 }] }, 'Invalid carryover page first sequence'],
    [{ ...manifest, pages: [{ ...page, messageCount: 0 }] }, 'Invalid carryover page message count'],
    [{ ...manifest, pages: [{ ...page, uncompressedBytes: 0.5 }] }, 'Invalid carryover page uncompressed bytes'],
    [{ ...manifest, pages: [{ ...page, compressedBytes: 0 }] }, 'Invalid carryover page compressed bytes'],
    [{ ...manifest, pages: [{ ...page, sha256: 'a'.repeat(63) }] }, 'Invalid carryover page checksum'],
    [{ ...manifest, pages: [{ ...page, firstSequence: 1 }] }, 'Carryover page sequences are not contiguous'],
    [{ ...manifest, messageCount: 3 }, 'Carryover segment message count is inconsistent'],
    [{ ...manifest, seedSanitation: 'unknown' }, 'Invalid carryover seed sanitation outcome'],
  ] as const) {
    expect(() => parseCarryOverSegmentIndex(value)).toThrow(message);
  }
  expect(() => parseCarryOverSegmentIndex(manifest, other)).toThrow('Carryover segment directory and index IDs differ');
});
