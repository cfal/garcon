#!/usr/bin/env bun
// Records the TypeScript controller's observable HTTP and WebSocket behavior
// and replays it against any build, following rust-anything's record/replay
// model. See rust/README.md.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { commandBuild, originalBuild, type ServerBuild } from './src/environment.js';
import { mergeRuns, readGolden, writeGolden } from './src/golden.js';
import { compareScenario, consoleReport, renderReport, type ScenarioResult } from './src/report.js';
import { runScenario } from './src/runner.js';
import { loadScenarios } from './src/scenario.js';
import { unitCli, UNIT_USAGE } from './src/unit/cli.js';

const repoRoot = resolve(import.meta.dir, '../..');

const usage = `Usage:
  bun rust/parity/cli.ts record [--scenario <name>]
  bun rust/parity/cli.ts replay [--build "<command>"] [--label <name>] [--scenario <name>] [--report <path>]
  bun rust/parity/cli.ts unit record <module.ts> --tests <test file>... [--inputs <file.jsonl>] --out <dir>
  bun rust/parity/cli.ts unit replay <dir>

record   Runs the original twice per scenario and writes rust/parity/golden/.
replay   Runs a build (default: the original) against the recordings, writes
         the report when --report is given, and exits non-zero on any
         mismatch.

Unit cases (ADR-020):
${UNIT_USAGE.split('\n').slice(1).join('\n')}`;

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
  consoleReport(results, report);
  return results.every((result) => result.cases.every((entry) => entry.difference === null) && !result.missingGolden);
}

const args = Bun.argv.slice(2);
if (args[0] === 'unit') process.exit(await unitCli(args.slice(1), repoRoot));

const { positionals, values } = parseArgs({
  args,
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
