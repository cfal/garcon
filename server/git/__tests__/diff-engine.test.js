import { describe, expect, it } from 'bun:test';
import { buildFullFileAddedPatch, countFullFileAddedLines } from '../full-file-patch.js';

describe('full-file addition patches', () => {
  it.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\n\n', 2],
    ['one\ntwo\n', 2],
  ])('counts file lines without inventing a terminal row', (content, expected) => {
    expect(countFullFileAddedLines(content)).toBe(expected);
  });

  it('builds a patch whose hunk count matches its added rows', () => {
    expect(buildFullFileAddedPatch('')).toBe('');
    expect(buildFullFileAddedPatch('one\ntwo\n')).toBe(
      '@@ -0,0 +1,2 @@\n+one\n+two',
    );
  });
});
