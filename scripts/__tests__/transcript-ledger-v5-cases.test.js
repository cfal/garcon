import { describe, expect, it } from 'bun:test';
import {
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

  it('validates the repository inventory', () => {
    expect(validateRepositoryTranscriptConformanceInventory().errors).toEqual([]);
  });
});
