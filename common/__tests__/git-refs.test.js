import { describe, expect, it } from 'bun:test';
import { DEFAULT_GIT_REF_SORT, isGitRefKind, parseGitRefSort } from '../git-refs.js';

describe('Git ref contract', () => {
  it('defaults only when both sort values are absent', () => {
    expect(parseGitRefSort(undefined, undefined)).toEqual(DEFAULT_GIT_REF_SORT);
    expect(parseGitRefSort(null, null)).toEqual(DEFAULT_GIT_REF_SORT);
    expect(parseGitRefSort('name', undefined)).toBeNull();
    expect(parseGitRefSort(undefined, 'asc')).toBeNull();
  });

  it('accepts every supported sort pair', () => {
    expect(parseGitRefSort('name', 'asc')).toEqual({
      key: 'name',
      direction: 'asc',
    });
    expect(parseGitRefSort('name', 'desc')).toEqual({
      key: 'name',
      direction: 'desc',
    });
    expect(parseGitRefSort('updated', 'asc')).toEqual({
      key: 'updated',
      direction: 'asc',
    });
    expect(parseGitRefSort('updated', 'desc')).toEqual({
      key: 'updated',
      direction: 'desc',
    });
  });

  it('rejects empty and unknown sort values', () => {
    expect(parseGitRefSort('', '')).toBeNull();
    expect(parseGitRefSort('created', 'asc')).toBeNull();
    expect(parseGitRefSort('name', 'forward')).toBeNull();
  });

  it('accepts only canonical ref kinds', () => {
    for (const kind of ['local-branch', 'remote-branch', 'tag', 'other']) {
      expect(isGitRefKind(kind)).toBe(true);
    }
    expect(isGitRefKind('branch')).toBe(false);
    expect(isGitRefKind(null)).toBe(false);
  });
});
