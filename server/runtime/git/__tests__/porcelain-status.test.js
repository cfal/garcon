import { describe, expect, it } from 'bun:test';

import { parsePorcelainV1Z } from '../porcelain-status.js';

describe('parsePorcelainV1Z', () => {
  it('parses plain, unmerged, and untracked entries', () => {
    const entries = parsePorcelainV1Z('M  a.txt\0 D b.txt\0UU c.txt\0?? d.txt\0');

    expect(entries).toEqual([
      { path: 'a.txt', indexStatus: 'M', workTreeStatus: ' ' },
      { path: 'b.txt', indexStatus: ' ', workTreeStatus: 'D' },
      { path: 'c.txt', indexStatus: 'U', workTreeStatus: 'U' },
      { path: 'd.txt', indexStatus: '?', workTreeStatus: '?' },
    ]);
  });

  it('consumes the original-path token for staged renames', () => {
    const entries = parsePorcelainV1Z('R  new.txt\0old.txt\0 M next.txt\0');

    expect(entries).toEqual([
      { path: 'new.txt', originalPath: 'old.txt', indexStatus: 'R', workTreeStatus: ' ' },
      { path: 'next.txt', indexStatus: ' ', workTreeStatus: 'M' },
    ]);
  });

  it('consumes the original-path token for unstaged renames without fabricating entries', () => {
    // An intent-to-add destination paired with a vanished source reports the
    // rename in the worktree column; git still appends the original path as a
    // second NUL token, which must not leak in as a phantom entry.
    const entries = parsePorcelainV1Z('DR dst.txt\0a.txt\0 R other.txt\0src.txt\0');

    expect(entries).toEqual([
      { path: 'dst.txt', originalPath: 'a.txt', indexStatus: 'D', workTreeStatus: 'R' },
      { path: 'other.txt', originalPath: 'src.txt', indexStatus: ' ', workTreeStatus: 'R' },
    ]);
  });
});
