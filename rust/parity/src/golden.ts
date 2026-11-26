import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scenario } from './scenario.js';
import { mergeRecordings, wildcardPaths, type Json } from './wildcard.js';
import type { CaseRun } from './runner.js';

export const GOLDEN_DIRECTORY = 'rust/parity/golden';

export interface GoldenCase {
  name: string;
  expected: Json;
  noise: string[];
}

// Recordings carry no fingerprint of the original's sources: replaying the
// original against them, as CI does, is the stronger check that they still
// describe its behavior.
export interface Golden {
  scenario: string;
  cases: GoldenCase[];
}

// Merges the original's two runs of a scenario into its golden expectation.
export function mergeRuns(scenario: Scenario, first: CaseRun[], second: CaseRun[]): Golden {
  if (first.length !== second.length) throw new Error(`${scenario.name}: the two recording runs produced different case counts`);
  return {
    scenario: scenario.name,
    cases: first.map((run, index) => {
      const expected = mergeRecordings(run.capture, second[index].capture);
      return { name: run.name, expected, noise: wildcardPaths(expected) };
    }),
  };
}

export async function writeGolden(repoRoot: string, golden: Golden): Promise<void> {
  const directory = join(repoRoot, GOLDEN_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${golden.scenario}.json`), `${JSON.stringify(golden, null, 2)}\n`);
}

export async function readGolden(repoRoot: string, scenario: string): Promise<Golden | null> {
  try {
    return JSON.parse(await readFile(join(repoRoot, GOLDEN_DIRECTORY, `${scenario}.json`), 'utf8')) as Golden;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
