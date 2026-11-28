import { expect, test } from 'bun:test';
import { buildReaderFrames, validateIndexerRows, validateReaderChunk, validateReaderStart } from './search-worker-oracle.ts';

const page = { text: '#731', order: 'relevance', mode: 'page', offset: 0, limit: 20, snippetLimit: 2 } as const;
const prefix = { text: 'synthetic', order: 'allowlist', mode: 'prefix', offset: 0, limit: 500, snippetLimit: 1 } as const;
const allowed = [
  { chatId: '0000000000000002', transcriptViewId: 'view-two', throughOrdinal: 4 },
  { chatId: '0000000000000001', transcriptViewId: 'view-one', throughOrdinal: 8 },
];

test('reader frames preserve priority and include an empty terminal frame', () => {
  expect(buildReaderFrames(page, [])).toHaveLength(2);
  expect(buildReaderFrames(prefix, allowed)[1]).toEqual({
    type: 'search-allowlist-chunk', chunkIndex: 0, allowedChats: allowed, done: true,
  });
});

test('enforces request admission bounds on typed frames', () => {
  expect(validateReaderStart(page)).toBe(true);
  expect(validateReaderStart(prefix)).toBe(true);
  expect(validateReaderStart({ ...prefix, offset: 1 })).toBe(false);
  expect(validateReaderStart({ ...prefix, snippetLimit: 2 })).toBe(false);
  expect(validateReaderStart({ ...page, limit: 101 })).toBe(false);
  expect(validateReaderChunk(allowed)).toBe(true);
  expect(validateReaderChunk([{ ...allowed[0]!, throughOrdinal: 2 ** 53 }])).toBe(false);
  expect(validateReaderChunk([{ ...allowed[0]!, transcriptViewId: '\u00e9'.repeat(129) }])).toBe(false);
  const row = { ordinal: 1, role: 'assistant', timestamp: null, body: 'Synthetic message.' } as const;
  expect(validateIndexerRows({ frameIndex: 0, rows: [row], advanceTo: 2 })).toBe(true);
  expect(validateIndexerRows({ frameIndex: 0, rows: [], advanceTo: 0 })).toBe(false);
  expect(validateIndexerRows({ frameIndex: 2 ** 53, rows: [row], advanceTo: 2 })).toBe(false);
  expect(validateIndexerRows({ frameIndex: 0, rows: [{ ...row, timestamp: '\u00e9'.repeat(129) }], advanceTo: 2 })).toBe(false);
});
