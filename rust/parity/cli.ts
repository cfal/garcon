#!/usr/bin/env bun
// Records the TypeScript controller's observable HTTP and WebSocket behavior
// and replays it against any build, following rust-anything's record/replay
// model. See rust/README.md.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { commandBuild, originalBuild, type ServerBuild } from './src/environment.js';
import { mergeRuns, readGolden, writeGolden } from './src/golden.js';
import { compareScenario, renderReport, type ScenarioResult } from './src/report.js';
import { runScenario } from './src/runner.js';
import { loadScenarios } from './src/scenario.js';

const repoRoot = resolve(import.meta.dir, '../..');

const usage = `Usage:
  bun rust/parity/cli.ts record [--scenario <name>]
  bun rust/parity/cli.ts replay [--build "<command>"] [--label <name>] [--scenario <name>] [--report <path>]

record   Runs the original twice per scenario and writes rust/parity/golden/.
replay   Runs a build (default: the original) against the recordings, writes
         the report when --report is given, and exits non-zero on any
         mismatch.`;

async function record(scenarioName: string | undefined): Promise<void> {
  const build = originalBuild();
  for (const scenario of await loadScenarios(repoRoot, scenarioName)) {
    const first = await runScenario(repoRoot, build, scenario);
    const second = await runScenario(repoRoot, build, scenario);
    const golden = mergeRuns(scenario, first, second);
    await writeGolden(repoRoot, golden);
    const noisy = golden.cases.filter((entry) => entry.noise.length > 0);
    console.log(`recorded ${scenario.name}: ${golden.cases.length} cases`);
    for (const entry of noisy) console.log(`  noise in ${entry.name}: ${entry.noise.join(', ')}`);
  }
}

async function replay(build: ServerBuild, label: string, scenarioName: string | undefined, reportPath: string | undefined): Promise<boolean> {
  const results: ScenarioResult[] = [];
  for (const scenario of await loadScenarios(repoRoot, scenarioName)) {
    const golden = await readGolden(repoRoot, scenario.name);
    const runs = golden ? await runScenario(repoRoot, build, scenario) : [];
    results.push(compareScenario(golden, runs, scenario.name));
  }
  const measuresFallback = build.label !== 'original';
  const report = renderReport(label, results, measuresFallback);
  if (reportPath) await writeFile(resolve(repoRoot, reportPath), report);
  const cases = results.flatMap((result) => result.cases);
  const failing = cases.filter((result) => result.difference);
  console.log(report.split('\n').slice(0, 6).join('\n'));
  for (const result of failing.slice(0, 20)) {
    console.log(`FAIL ${result.scenario}/${result.name} at ${result.difference!.path}: expected ${result.difference!.expected}, got ${result.difference!.actual}`);
  }
  return failing.length === 0 && results.every((result) => !result.missingGolden);
}

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    scenario: { type: 'string' },
    build: { type: 'string' },
    label: { type: 'string' },
    report: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];
if (values.help || (command !== 'record' && command !== 'replay')) {
  console.log(usage);
  process.exit(values.help ? 0 : 2);
}
if (command === 'record') {
  await record(values.scenario);
} else {
  const build = values.build ? commandBuild(values.build) : originalBuild();
  const label = values.label ?? build.label;
  const passed = await replay(build, label, values.scenario, values.report);
  process.exit(passed ? 0 : 1);
}
