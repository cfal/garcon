import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pinnedBunVersion } from './bun-version.js';
import { readKnownDifferences } from './known-differences.js';
import { readTraceExclusions, traceGroup } from './trace-unstable.js';
import { compareTraces, formatTraceDifferences, mergeTraces, readTraces, writeTraces, type Traces } from './traces.js';

export const TRACES_USAGE = `  bun rust/parity/cli.ts traces record --suite <test file>... --out <dir> [--runs <N>]
  bun rust/parity/cli.ts traces compare <golden dir> <run dir>`;

function recordArgs(args: string[]): { suites: string[]; output: string; runs: number } {
  const suites: string[] = [];
  let collecting = false;
  let output: string | undefined;
  let runs = 2;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--suite') {
      collecting = true;
    } else if (argument === '--out') {
      collecting = false;
      output = args[++index];
      if (!output || output.startsWith('-')) throw new Error('--out requires a directory');
    } else if (argument === '--runs') {
      collecting = false;
      const value = args[++index];
      runs = Number(value);
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(runs) || runs < 2) {
        throw new Error('--runs requires an integer of at least 2');
      }
    } else if (collecting && !argument.startsWith('-')) {
      suites.push(argument);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (!output || suites.length === 0) throw new Error('Recording traces requires --suite and --out');
  return { suites, output: resolve(output), runs };
}

async function runSuite(repoRoot: string, file: string, directory: string): Promise<void> {
  const child = Bun.spawn([process.execPath, 'test', '--max-concurrency=1', '--timeout=30000', file], {
    cwd: join(repoRoot, 'integration-tests'),
    env: {
      ...process.env,
      GARCON_TEST_CONTROLLER: 'original',
      GARCON_TEST_WORKER: 'original',
      GARCON_TEST_TRACE_DIR: directory,
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${relative(repoRoot, file)} exited ${code}`);
}

async function record(repoRoot: string, args: string[]): Promise<number> {
  const { suites, output, runs } = recordArgs(args);
  const pinned = await pinnedBunVersion(repoRoot);
  if (Bun.version !== pinned) throw new Error(`Recording suite traces requires Bun ${pinned}; this is ${Bun.version}`);
  const exclusions = await readTraceExclusions(repoRoot);
  let failed = false;
  for (const suite of suites) {
    const file = resolve(suite);
    const name = relative(repoRoot, file);
    if (name.startsWith('../') || !await Bun.file(file).exists()) throw new Error(`Not a test file in this repository: ${suite}`);
    const directory = await mkdtemp(join(tmpdir(), 'garcon-traces-'));
    try {
      const samples: Traces[] = [];
      for (let index = 0; index < runs; index++) {
        const sample = join(directory, String(index));
        await runSuite(repoRoot, file, sample);
        const trace = await readTraces(sample, 'jsonl');
        if (!trace.has(name)) throw new Error(`The client captured no traces in run ${index + 1}`);
        samples.push(trace);
      }
      const [first, second, ...rest] = samples;
      const declared = exclusions.filter((entry) => entry.suite === name);
      const { golden, problems, noise, unstableBroadcasts } = mergeTraces([first!, second!, ...rest], declared);
      for (const wildcard of noise) console.log(`wildcard ${wildcard}`);
      for (const entry of declared) {
        const target = 'test' in entry ? entry.test + (entry.path ? ` at ${entry.path}` : '') : traceGroup(entry.chat, entry.type);
        console.log(`DECLARED UNSTABLE ${name} > ${target}: ${entry.reason}`);
      }
      if (unstableBroadcasts.length) {
        console.log(formatTraceDifferences(unstableBroadcasts, 'UNSTABLE BROADCAST (not compared)'));
      }
      if (problems.length) {
        console.error(formatTraceDifferences(problems));
        failed = true;
      } else {
        await writeTraces(output, golden);
        const tests = declared.filter((entry) => 'test' in entry && !entry.path).length;
        const paths = declared.filter((entry) => 'test' in entry && entry.path).length;
        console.log(`Recorded ${name}: ${Object.keys(golden.get(name) ?? {}).length} tests, ${noise.length} wildcards, ${tests} tests, ${paths} paths, and ${declared.length - tests - paths + unstableBroadcasts.length} broadcast groups excluded`);
      }
    } catch (error) {
      console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return failed ? 1 : 0;
}

export async function tracesCli(args: string[], repoRoot: string): Promise<number> {
  const [command, ...operands] = args;
  try {
    if (command === 'record') return await record(repoRoot, operands);
    if (command === 'compare' && operands.length === 2) {
      const expected = await readTraces(operands[0]!, 'json');
      const actual = await readTraces(operands[1]!, 'jsonl');
      if (expected.size === 0) throw new Error('No golden traces found');
      const { total, problems, excludedBroadcasts, excludedTests, excludedPaths } = compareTraces(expected, actual, await readKnownDifferences(repoRoot), await readTraceExclusions(repoRoot));
      console.log(`Matched ${total - problems.length}/${total} traced tests`);
      if (excludedBroadcasts || excludedTests || excludedPaths) {
        console.log(`Excluded as unstable: ${excludedTests} tests, ${excludedPaths} paths, ${excludedBroadcasts} broadcast groups`);
      }
      if (problems.length) console.log(formatTraceDifferences(problems));
      return problems.length ? 1 : 0;
    }
    console.log(TRACES_USAGE);
    return command === '--help' || command === '-h' ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
