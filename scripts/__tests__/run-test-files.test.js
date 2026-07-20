import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  createTestBatches,
  ISOLATED_TEST_FILES,
  parseArguments,
} from '../run-test-files.js';

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

  test('isolates tests that install process-global module mocks', async () => {
    const repositoryRoot = resolve(import.meta.dir, '../..');
    const testFiles = [
      ...new Bun.Glob('server/**/*.test.{js,ts}').scanSync({
        cwd: repositoryRoot,
        onlyFiles: true,
      }),
      ...new Bun.Glob('server-agents/**/*.test.{js,ts}').scanSync({
        cwd: repositoryRoot,
        onlyFiles: true,
      }),
    ].sort((left, right) => left.localeCompare(right));
    const unisolatedModuleMocks = [];

    for (const file of testFiles) {
      if (
        (await Bun.file(resolve(repositoryRoot, file)).text()).includes('mock.module')
        && !ISOLATED_TEST_FILES.has(file)
      ) {
        unisolatedModuleMocks.push(file);
      }
    }

    expect(unisolatedModuleMocks).toEqual([]);
  });
});
