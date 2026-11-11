import { describe, expect, it } from 'bun:test';
import {
  benchmarkScenarioFileNames,
  parseGitReviewBenchmarkOptions,
} from '../benchmark-git-review.js';

describe('Git review benchmark', () => {
  it('parses bounded benchmark options', () => {
    expect(parseGitReviewBenchmarkOptions([
      '--scenario',
      'working-tree-many',
      '--iterations',
      '3',
    ])).toEqual({
      scenario: 'working-tree-many',
      iterations: 3,
      batchFiles: 4,
    });
    expect(() => parseGitReviewBenchmarkOptions(['--iterations', '0'])).toThrow(
      'Iterations must be an integer between 1 and 100.',
    );
    expect(parseGitReviewBenchmarkOptions(['--scenario', 'workbench-many', '--batch-files', '1']).batchFiles).toBe(1);
    for (const value of ['0', '25', '1.5', 'invalid']) {
      expect(() => parseGitReviewBenchmarkOptions(['--batch-files', value])).toThrow('Batch files must be an integer between 1 and 24.');
    }
  });

  it('generates deterministic scenario file names', () => {
    expect(benchmarkScenarioFileNames('revision-24')).toHaveLength(24);
    expect(benchmarkScenarioFileNames('working-tree-many')).toHaveLength(240);
    expect(benchmarkScenarioFileNames('revision-many')).toHaveLength(1000);
    expect(benchmarkScenarioFileNames('workbench-many')).toHaveLength(1000);
    expect(benchmarkScenarioFileNames('large-file')).toEqual(['large.ts']);
    expect(benchmarkScenarioFileNames('revision-24').slice(0, 2)).toEqual([
      'src/file-0000.ts',
      'src/file-0001.ts',
    ]);
  });
});
