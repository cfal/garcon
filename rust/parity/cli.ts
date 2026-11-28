#!/usr/bin/env bun
// Records the TypeScript controller's observable HTTP and WebSocket behavior
// and replays it against any build, following rust-anything's record/replay
// model. See rust/README.md.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bunCheck, pinnedBunVersion } from './src/bun-version.js';
import { commandBuild, originalBuild, type ServerBuild } from './src/environment.js';
import { mergeRuns, readGolden, writeGolden } from './src/golden.js';
import { readKnownDifferences, scenarioKnownDifferencesForBuild } from './src/known-differences.js';
import { compareScenario, renderReport, replayPassed, replaySummary, type ScenarioResult } from './src/report.js';
import { runScenario } from './src/runner.js';
import { loadScenarios } from './src/scenario.js';
import { unitCli, UNIT_USAGE } from './src/unit/cli.js';
import { tracesCli, TRACES_USAGE } from './src/traces-cli.js';

const repoRoot = resolve(import.meta.dir, '../..');

const usage = `Usage:
  bun rust/parity/cli.ts record [--scenario <name>] [--any-bun]
  bun rust/parity/cli.ts replay [--build "<command>"] [--label <name>] [--scenario <name>] [--report <path>] [--allow-unported]
  bun rust/parity/cli.ts unit record <module.ts> --tests <test file>... [--inputs <file.jsonl>] [--guard <function>:<argument index>=<guard>]... [--json <function>:<argument index>]... [--instances] [--any-bun] --out <dir>
  bun rust/parity/cli.ts unit replay <dir>

record   Runs the original twice per scenario and writes rust/parity/golden/.
         It runs only on the Bun the repository pins (ADR-026), unless
         --any-bun is given.
replay   Runs a build (default: the original) against the recordings, writes
         the report when --report is given, and exits non-zero on any
         mismatch. Unported, blocked, and differing cases after unported writes
         also fail unless --allow-unported is given. It warns on another Bun.

Suite traces (ADR-020):
${TRACES_USAGE}

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

async function replay(build: ServerBuild, label: string, scenarioName: string | undefined, reportPath: string | undefined, compareKnown: boolean, allowUnported: boolean): Promise<boolean> {
  const results: ScenarioResult[] = [];
  const known = compareKnown ? scenarioKnownDifferencesForBuild(await readKnownDifferences(repoRoot), label) : [];
  const scenarios = await loadScenarios(repoRoot, scenarioName);
  if (!scenarioName) {
    const names = new Set(scenarios.map((scenario) => scenario.name));
    const stale = known.find((entry) => !names.has(entry.name));
    if (stale) throw new Error(`Stale known difference for unknown scenario ${stale.name}`);
  }
  for (const scenario of scenarios) {
    const golden = await readGolden(repoRoot, scenario.name);
    const runs = golden ? await runScenario(repoRoot, build, scenario) : [];
    results.push(compareScenario(golden, runs, scenario.name, known));
  }
  const measuresFallback = build.label !== 'original';
  const report = renderReport(label, results, measuresFallback);
  if (reportPath) await writeFile(resolve(repoRoot, reportPath), report);
  console.log(replaySummary(results, report));
  return replayPassed(results, allowUnported);
}

const args = Bun.argv.slice(2);
if (args[0] === 'unit') process.exit(await unitCli(args.slice(1), repoRoot));
if (args[0] === 'traces') process.exit(await tracesCli(args.slice(1), repoRoot));

const { positionals, values } = parseArgs({
  args,
  allowPositionals: true,
  options: {
    scenario: { type: 'string' },
    build: { type: 'string' },
    label: { type: 'string' },
    report: { type: 'string' },
    'allow-unported': { type: 'boolean' },
    // Records on another Bun than the pinned one.
    'any-bun': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];
if (values.help || (command !== 'record' && command !== 'replay')) {
  console.log(usage);
  process.exit(values.help ? 0 : 2);
}
// The original behaves differently on another Bun, so a recording has to come from the pinned one.
const bun = bunCheck(command, Bun.version, await pinnedBunVersion(repoRoot), values['any-bun'] === true);
if (bun.refuse) {
  console.error(bun.warning);
  process.exit(2);
}
if (bun.warning) console.error(`warning: ${bun.warning}`);
if (command === 'record') {
  await record(values.scenario);
} else {
  const build = values.build ? commandBuild(values.build) : originalBuild();
  const label = values.label ?? build.label;
  const passed = await replay(build, label, values.scenario, values.report, Boolean(values.build), values['allow-unported'] === true);
  process.exit(passed ? 0 : 1);
}
