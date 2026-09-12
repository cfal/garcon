import { describe, expect, it } from 'bun:test';
import { parseFileMentionTokens } from '../file-mentions.js';

describe('parseFileMentionTokens', () => {
  it('parses bare and quoted @file mentions', () => {
    expect(parseFileMentionTokens('read @src/main.ts and @"docs/design note.md"')).toEqual([
      { path: 'src/main.ts', start: 5, end: 17 },
      { path: 'docs/design note.md', start: 22, end: 44 },
    ]);
  });

  it('ignores @ inside regular words', () => {
    expect(parseFileMentionTokens('email alex@example.com and branch@{upstream}')).toEqual([]);
  });
});
