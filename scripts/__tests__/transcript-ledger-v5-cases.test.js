import { describe, expect, it } from 'bun:test';
import {
  readTranscriptConformanceSources,
  validateRepositoryTranscriptConformanceInventory,
  validateTranscriptConformanceInventory,
} from '../validate-transcript-ledger-v5-cases.js';

function testSource(id, title) {
  return `it('[${id}] ${title}', () => {});`;
}

describe('Transcript Ledger V5 case inventory', () => {
  it('accepts one source occurrence for every sorted inventory ID', () => {
    const result = validateTranscriptConformanceInventory(
      'TLV5-L02.01-STORE-UNIT-01\nTLV5-L03.01-CORE-UNIT-01\n',
      [
        {
          path: 'first.test.js',
          contents: testSource('TLV5-L02.01-STORE-UNIT-01', 'commits rows'),
        },
        {
          path: 'second.test.ts',
          contents: testSource('TLV5-L03.01-CORE-UNIT-01', 'publishes after commit'),
        },
      ],
    );

    expect(result).toEqual({
      cases: [
        { id: 'TLV5-L02.01-STORE-UNIT-01', location: 'first.test.js:1' },
        { id: 'TLV5-L03.01-CORE-UNIT-01', location: 'second.test.ts:1' },
      ],
      errors: [],
    });
  });

  it('rejects unsorted, duplicate, missing, repeated, and unregistered IDs', () => {
    const result = validateTranscriptConformanceInventory(
      [
        'TLV5-L03.01-CORE-UNIT-01',
        'TLV5-L02.01-STORE-UNIT-01',
        'TLV5-L02.01-STORE-UNIT-01',
        'TLV5-L04.01-CORE-UNIT-01',
        '',
      ].join('\n'),
      [
        {
          path: 'cases.test.js',
          contents: [
            testSource('TLV5-L02.01-STORE-UNIT-01', 'first'),
            testSource('TLV5-L02.01-STORE-UNIT-01', 'duplicate'),
            testSource('TLV5-L05.01-CORE-UNIT-01', 'unregistered'),
          ].join('\n'),
        },
      ],
    );

    expect(result.errors).toEqual([
      'Inventory case IDs must be unique',
      'Inventory case IDs must be sorted',
      'Missing test case: TLV5-L03.01-CORE-UNIT-01',
      'Duplicate test case TLV5-L02.01-STORE-UNIT-01: cases.test.js:1, cases.test.js:2',
      'Missing test case: TLV5-L04.01-CORE-UNIT-01',
      'Unregistered test case TLV5-L05.01-CORE-UNIT-01: cases.test.js:3',
    ]);
  });

  it('reads sources concurrently within a fixed filesystem budget', async () => {
    const gate = Promise.withResolvers();
    const paths = Array.from({ length: 24 }, (_, index) => `${index}.test.js`);
    let active = 0;
    let maximum = 0;
    let started = 0;
    const reading = readTranscriptConformanceSources(paths, async (path) => {
      started += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active -= 1;
      return path;
    });

    try {
      expect(started).toBe(8);
    } finally {
      gate.resolve();
      await reading;
    }
    expect(maximum).toBe(8);
    expect(started).toBe(paths.length);
    expect(await reading).toEqual(paths.map((path) => ({ path, contents: path })));
  });

  it('preserves discovery order when reads finish out of order', async () => {
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    const reading = readTranscriptConformanceSources(['first.test.js', 'second.test.js'],
      (path) => path === 'first.test.js' ? first.promise : second.promise);
    second.resolve('second contents');
    first.resolve('first contents');
    expect(await reading).toEqual([
      { path: 'first.test.js', contents: 'first contents' },
      { path: 'second.test.js', contents: 'second contents' },
    ]);
  });

  it('skips deleted test files without hiding unreadable sources', async () => {
    expect(await readTranscriptConformanceSources(['deleted.test.js', 'present.test.js'], (path) => {
      if (path === 'deleted.test.js') throw Object.assign(new Error('deleted'), { code: 'ENOENT' });
      return Promise.resolve('present contents');
    })).toEqual([{ path: 'present.test.js', contents: 'present contents' }]);
    const failure = Object.assign(new Error('unreadable'), { code: 'EACCES' });
    await expect(readTranscriptConformanceSources(['unreadable.test.js'], () => {
      throw failure;
    })).rejects.toBe(failure);
  });

  it('validates the repository inventory', async () => {
    expect((await validateRepositoryTranscriptConformanceInventory()).errors).toEqual([]);
  });
});
