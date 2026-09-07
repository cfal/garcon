import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('transcript paging architecture', () => {
  it('[TLV5-PAGE.08-STORE-STATIC-01] derives continuation from the bounded row query without an existence query', () => {
    const storeSource = readFileSync(new URL('../store.ts', import.meta.url), 'utf8');

    expect(storeSource).not.toMatch(/SELECT\s+1\s+AS\s+found\s+FROM\s+transcript_rows/i);
    expect(storeSource).not.toContain('hasOlder');
  });
});
