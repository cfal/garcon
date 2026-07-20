import { describe, expect, test } from 'bun:test';
import { createTestBatches, parseArguments } from '../run-test-files.js';

describe('run-test-files', () => {
  test('keeps the one-file default and accepts an explicit batch size', () => {
    expect(parseArguments(['server/**/*.test.js'])).toEqual({
      pattern: 'server/**/*.test.js',
      batchSize: 1,
    });
    expect(parseArguments(['server/**/*.test.js', '--batch', '8'])).toEqual({
      pattern: 'server/**/*.test.js',
      batchSize: 8,
    });
  });

  test('rejects missing, malformed, and unknown arguments', () => {
    expect(() => parseArguments([])).toThrow('A test glob is required');
    expect(() => parseArguments(['*.test.js', '--batch', '0'])).toThrow('positive integer');
    expect(() => parseArguments(['*.test.js', '--batch', '1.5'])).toThrow('positive integer');
    expect(() => parseArguments(['*.test.js', '--wat'])).toThrow('Unknown option');
  });

  test('preserves file order while fencing isolated tests into their own process', () => {
    expect(createTestBatches(
      ['a.test.js', 'b.test.js', 'isolated.test.js', 'c.test.js', 'd.test.js', 'e.test.js'],
      2,
      new Set(['isolated.test.js']),
    )).toEqual([
      ['a.test.js', 'b.test.js'],
      ['isolated.test.js'],
      ['c.test.js', 'd.test.js'],
      ['e.test.js'],
    ]);
  });
});
