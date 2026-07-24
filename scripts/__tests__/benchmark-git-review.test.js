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
    });
    expect(() => parseGitReviewBenchmarkOptions(['--iterations', '0'])).toThrow(
      'Iterations must be an integer between 1 and 100.',
    );
  });

  it('generates deterministic scenario file names', () => {
    expect(benchmarkScenarioFileNames('revision-24')).toHaveLength(24);
    expect(benchmarkScenarioFileNames('working-tree-many')).toHaveLength(240);
    expect(benchmarkScenarioFileNames('large-file')).toEqual(['large.txt']);
    expect(benchmarkScenarioFileNames('revision-24').slice(0, 2)).toEqual([
      'src/file-000.txt',
      'src/file-001.txt',
    ]);
  });
});
