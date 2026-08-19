import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  TRANSCRIPT_SEARCH_V8_PROOF_BUN_VERSION,
  TRANSCRIPT_SEARCH_V8_PROOF_OPERATIONS,
  TRANSCRIPT_SEARCH_V8_PROOF_SHAPES,
  TRANSCRIPT_SEARCH_V8_PROOF_SQLITE_VERSION,
  TRANSCRIPT_SEARCH_V8_RSS_OPERATIONS,
  TRANSCRIPT_SEARCH_V8_RSS_SHAPES,
} from '../transcript-search-v8-runtime-proof.ts';
import {
  SEARCH_INDEXER_CACHE_SIZE_PAGES,
  SEARCH_MAX_DIRTY_FRAMES,
  SEARCH_MAX_WAL_BYTES,
  SEARCH_SCHEMA_SQL_SHA256,
  SEARCH_TERM_STEP_MAX_ROWS,
  SEARCH_WAL_HIGH_WATER_FRAMES,
} from '../../server-agents/common/src/search/schema.ts';

describe('transcript search v8 runtime proof', () => {
  test('[TLV5-SEARCH.06-FRAME-RUNTIME-01] couples the sole runtime proof to production authorities', async () => {
    expect({
      bun: TRANSCRIPT_SEARCH_V8_PROOF_BUN_VERSION,
      sqlite: TRANSCRIPT_SEARCH_V8_PROOF_SQLITE_VERSION,
      K: SEARCH_TERM_STEP_MAX_ROWS,
      F: SEARCH_MAX_DIRTY_FRAMES,
      H: SEARCH_WAL_HIGH_WATER_FRAMES,
      cacheSize: SEARCH_INDEXER_CACHE_SIZE_PAGES,
      maximumWalBytes: SEARCH_MAX_WAL_BYTES,
      schemaSqlSha256: SEARCH_SCHEMA_SQL_SHA256,
    }).toEqual({
      bun: '1.4.0',
      sqlite: '3.53.2',
      K: 32,
      F: 49_829,
      H: 199_316,
      cacheSize: 49_893,
      maximumWalBytes: 821_181_952,
      schemaSqlSha256: 'f145dd5094386f487d77762af6dd1417c3643a01214239009a0f88d40ee74797',
    });
    expect(TRANSCRIPT_SEARCH_V8_PROOF_OPERATIONS).toHaveLength(16);
    expect(TRANSCRIPT_SEARCH_V8_PROOF_SHAPES).toHaveLength(5);
    expect(TRANSCRIPT_SEARCH_V8_RSS_OPERATIONS).toHaveLength(6);
    expect(TRANSCRIPT_SEARCH_V8_RSS_SHAPES).toHaveLength(3);

    const source = await readFile(new URL('../transcript-search-v8-runtime-proof.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('CREATE TABLE search_');
    expect(source).not.toContain('CREATE INDEX search_');
    for (const productionFunction of [
      'openSearchDatabase',
      'SearchTokenizer',
      'stageRawChunks',
      'buildTermStep',
      'cleanupStep',
      'markPrunedChats',
      'observeWal',
      'truncateWal',
    ]) {
      expect(source).toContain(productionFunction);
    }
  });
});
