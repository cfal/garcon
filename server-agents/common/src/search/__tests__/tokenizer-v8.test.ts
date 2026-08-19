import { describe, expect, it } from 'bun:test';
import {
  SEARCH_APPROVED_FTS5_SOURCE_ID,
  SEARCH_QUERY_MAX_NATIVE_TOKENS,
  SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES,
  SEARCH_TOKENIZER_HASH_SIZE_BYTES,
  SEARCH_TOKENIZER_MAX_NATIVE_TOKENS,
  SEARCH_TOKENIZER_MAX_POSITION_BYTES,
  SEARCH_TOKENIZER_MAX_ROWS,
  SearchTokenizer,
  decodeCanonicalPositions,
  encodeCanonicalPositions,
} from '../tokenizer.js';

const APPROVED_FINGERPRINT = '3614f048777f7becf10ec03b0c7b607db11f334fbf0d13d12e7cd05e17d523b8';

describe('transcript search v8 tokenizer', () => {
  it('[TLV5-SEARCH.10-TOKENIZER-CORE-UNIT-01] locks the sole runtime semantics and native query positions', () => {
    const tokenizer = SearchTokenizer.create();
    try {
      expect(tokenizer.sourceId).toBe(SEARCH_APPROVED_FTS5_SOURCE_ID);
      expect(Buffer.from(tokenizer.fingerprint).toString('hex')).toBe(APPROVED_FINGERPRINT);
      expect(tokenizer.tokenizeQuery('Crème 東京 foo_bar 한글').map((token) => ({
        term: Buffer.from(token.term).toString('utf8'),
        position: token.position,
      }))).toEqual([
        { term: 'creme', position: 0 },
        { term: '東京', position: 1 },
        { term: 'foo', position: 2 },
        { term: 'bar', position: 3 },
        { term: '한글', position: 4 },
      ]);
      expect(SEARCH_QUERY_MAX_NATIVE_TOKENS).toBe(8_192);
      expect(SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES).toBe(32 * 1_024);
    } finally {
      tokenizer.close();
    }
  });

  it('emits byte-sorted canonical postings and the logical pad length', () => {
    const tokenizer = SearchTokenizer.create();
    try {
      const document = tokenizer.tokenizeDocument('beta alpha beta');
      expect(document.tokenCount).toBe(4);
      expect(document.termCount).toBe(2);
      expect(document.postings.map((posting) => Buffer.from(posting.term).toString())).toEqual([
        'alpha',
        'beta',
      ]);
      expect(document.postings.map((posting) => decodeCanonicalPositions({
        encoded: posting.positions,
        frequency: posting.frequency,
        maxPositionExclusive: document.tokenCount - 1,
      }))).toEqual([[1], [0, 2]]);

      const zero = tokenizer.tokenizeDocument('_');
      expect(zero).toMatchObject({ tokenCount: 1, termCount: 0, postings: [] });

      const truncated = tokenizer.tokenizeDocument('x'.repeat(40_000));
      expect(truncated.termCount).toBe(1);
      expect(truncated.postings[0]!.term.byteLength).toBe(32_768);
    } finally {
      tokenizer.close();
    }
  });

  it('selects the longest multi-document prefix within native occurrence caps', () => {
    const tokenizer = SearchTokenizer.create();
    try {
      const full = 'a '.repeat(32_000);
      const tail = 'a '.repeat(1_536);
      const batch = tokenizer.tokenizeDocuments([full, full, tail, 'a']);
      expect(batch.acceptedDocumentCount).toBe(3);
      expect(batch.nativeTokenCount).toBe(SEARCH_TOKENIZER_MAX_NATIVE_TOKENS);
      expect(batch.positionBytes).toBeLessThanOrEqual(SEARCH_TOKENIZER_MAX_POSITION_BYTES);
      expect(SEARCH_TOKENIZER_MAX_NATIVE_TOKENS * 3)
        .toBeLessThanOrEqual(SEARCH_TOKENIZER_MAX_POSITION_BYTES);
      expect(SEARCH_TOKENIZER_HASH_SIZE_BYTES).toBe(8 * 1_024 * 1_024);
      expect(SEARCH_TOKENIZER_HASH_SIZE_BYTES).toBeLessThan(32 * 1_024 * 1_024);
      expect(() => tokenizer.tokenizeDocuments(Array.from(
        { length: SEARCH_TOKENIZER_MAX_ROWS + 1 },
        () => '_',
      ))).toThrow('SEARCH_TOKENIZER_INVALID');
      expect(tokenizer.tokenizeDocument('_')).toMatchObject({ tokenCount: 1, termCount: 0 });
    } finally {
      tokenizer.close();
    }
  });

  it('rejects query vocab at native-token and normalized-byte cap plus one and recovers cleanly', () => {
    const tokenizer = SearchTokenizer.create();
    try {
      const nativeLimit = 'a '.repeat(SEARCH_QUERY_MAX_NATIVE_TOKENS);
      expect(tokenizer.tokenizeQuery(nativeLimit)).toHaveLength(SEARCH_QUERY_MAX_NATIVE_TOKENS);
      expect(() => tokenizer.tokenizeQuery(`${nativeLimit}a`)).toThrow('SEARCH_QUERY_INVALID');
      expect(tokenizer.tokenizeQuery('after native rejection')).toHaveLength(3);

      const byteLimit = 'a'.repeat(SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES);
      expect(tokenizer.tokenizeQuery(byteLimit)[0]?.term.byteLength)
        .toBe(SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES);
      expect(() => tokenizer.tokenizeQuery(`${byteLimit} b`)).toThrow('SEARCH_QUERY_INVALID');
      expect(tokenizer.tokenizeQuery('after byte rejection')).toHaveLength(3);
    } finally {
      tokenizer.close();
    }
  });

  it('rejects non-canonical, truncated, overflowing, and out-of-range postings', () => {
    const encoded = encodeCanonicalPositions([0, 127, 128, 16_384]);
    expect(decodeCanonicalPositions({
      encoded,
      frequency: 4,
      maxPositionExclusive: 20_000,
    })).toEqual([0, 127, 128, 16_384]);

    const invalid = [
      { encoded: Uint8Array.of(0), frequency: 1, maxPositionExclusive: 2 },
      { encoded: Uint8Array.of(0x81, 0), frequency: 1, maxPositionExclusive: 2 },
      { encoded: Uint8Array.of(0x81), frequency: 1, maxPositionExclusive: 2 },
      { encoded: Uint8Array.of(1, 1), frequency: 1, maxPositionExclusive: 3 },
      { encoded: Uint8Array.of(3), frequency: 1, maxPositionExclusive: 2 },
      {
        encoded: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
        frequency: 1,
        maxPositionExclusive: 2,
      },
    ];
    for (const value of invalid) {
      expect(() => decodeCanonicalPositions(value)).toThrow('SEARCH_POSTING_INVALID');
    }
  });
});
