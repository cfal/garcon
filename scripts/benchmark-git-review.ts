import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitService } from '../server/git/git-service.js';

export type GitReviewBenchmarkScenario =
  | 'revision-24'
  | 'working-tree-many'
  | 'large-file';

export interface GitReviewBenchmarkOptions {
  scenario: GitReviewBenchmarkScenario;
  iterations: number;
}

interface BenchmarkFixture {
  projectPath: string;
  fromRevision: string;
  to: { kind: 'revision'; revision: string } | { kind: 'working-tree' };
}

interface IterationResult {
  snapshotMs: number;
  visibleBodyMs: number;
  prefetchBodyMs: number;
  totalMs: number;
  commandCount: number;
  rowCount: number;
  patchBytes: number;
}

const SCENARIOS = new Set<GitReviewBenchmarkScenario>([
  'revision-24',
  'working-tree-many',
  'large-file',
]);

export function parseGitReviewBenchmarkOptions(args: string[]): GitReviewBenchmarkOptions {
  let scenario: GitReviewBenchmarkScenario = 'revision-24';
  let iterations = 10;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--scenario') {
      const value = args[++index] as GitReviewBenchmarkScenario | undefined;
      if (!value || !SCENARIOS.has(value)) throw new Error(`Unknown benchmark scenario: ${value}`);
      scenario = value;
    } else if (argument === '--iterations') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value <= 0 || value > 100) {
        throw new Error('Iterations must be an integer between 1 and 100.');
      }
      iterations = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { scenario, iterations };
}

export function benchmarkScenarioFileNames(
  scenario: GitReviewBenchmarkScenario,
): string[] {
  const count = scenario === 'working-tree-many' ? 240 : scenario === 'revision-24' ? 24 : 1;
  return Array.from({ length: count }, (_, index) =>
    scenario === 'large-file'
      ? 'large.txt'
      : `src/file-${String(index).padStart(3, '0')}.txt`);
}

async function runGit(projectPath: string, args: string[]): Promise<string> {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

function fileContents(
  index: number,
  changed: boolean,
  lineCount = 40,
  changeEveryLine = false,
): string {
  return Array.from(
    { length: lineCount },
    (_, line) =>
      `${changed && (changeEveryLine || line === lineCount - 1) ? 'changed' : 'base'} ${index}:${line}`,
  ).join('\n') + '\n';
}

async function createFixture(
  scenario: GitReviewBenchmarkScenario,
): Promise<BenchmarkFixture> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-review-bench-'));
  await runGit(projectPath, ['init', '-q']);
  await runGit(projectPath, ['config', 'user.email', 'benchmark@example.com']);
  await runGit(projectPath, ['config', 'user.name', 'Benchmark']);
  const files = benchmarkScenarioFileNames(scenario);
  for (let index = 0; index < files.length; index += 1) {
    const filePath = path.join(projectPath, files[index]);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lineCount = scenario === 'large-file' ? 20_000 : 40;
    await fs.writeFile(filePath, fileContents(index, false, lineCount));
  }
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-q', '-m', 'base']);
  const fromRevision = await runGit(projectPath, ['rev-parse', 'HEAD']);

  for (let index = 0; index < files.length; index += 1) {
    const lineCount = scenario === 'large-file' ? 20_000 : 40;
    await fs.writeFile(
      path.join(projectPath, files[index]),
      fileContents(index, true, lineCount, scenario === 'large-file'),
    );
  }
  if (scenario === 'working-tree-many') {
    return { projectPath, fromRevision, to: { kind: 'working-tree' } };
  }
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-q', '-m', 'target']);
  return {
    projectPath,
    fromRevision,
    to: { kind: 'revision', revision: await runGit(projectPath, ['rev-parse', 'HEAD']) },
  };
}

function createService() {
  return createGitService({
    agents: { runSingleQuery: async () => 'chore: benchmark' },
    classifyGitError: (error) => ({
      status: 500,
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

async function runIteration(fixture: BenchmarkFixture): Promise<IterationResult> {
  const service = createService();
  const trace = [];
  const startedAt = performance.now();
  const snapshotStartedAt = performance.now();
  const snapshot = await service.getComparisonSnapshot({
    projectPath: fixture.projectPath,
    from: { kind: 'revision', revision: fixture.fromRevision },
    to: fixture.to,
    mode: 'direct',
    context: 3,
    bodyCandidateCount: 24,
    trace,
  });
  const snapshotMs = performance.now() - snapshotStartedAt;
  if (snapshot.status !== 'ready') throw new Error(`Snapshot failed with ${snapshot.status}.`);
  const [visiblePath, ...prefetchPaths] = snapshot.firstBodyCandidates;
  if (!visiblePath) throw new Error('Benchmark fixture produced no reviewable files.');

  const visibleStartedAt = performance.now();
  const visiblePromise = service.getReviewDocumentFileBodies({
    projectPath: fixture.projectPath,
    documentId: snapshot.documentId,
    files: [visiblePath],
    purpose: 'visible',
    trace,
  }).then((response) => ({
    response,
    durationMs: performance.now() - visibleStartedAt,
  }));
  const prefetchStartedAt = performance.now();
  const prefetchPromise = prefetchPaths.length > 0
    ? service.getReviewDocumentFileBodies({
        projectPath: fixture.projectPath,
        documentId: snapshot.documentId,
        files: prefetchPaths,
        purpose: 'prefetch',
        trace,
      }).then((response) => ({
        response,
        durationMs: performance.now() - prefetchStartedAt,
      }))
    : Promise.resolve({ response: null, durationMs: 0 });
  const [visible, prefetch] = await Promise.all([visiblePromise, prefetchPromise]);
  if (visible.response.status !== 'ready') {
    throw new Error(`Visible body failed with ${visible.response.status}.`);
  }
  if (prefetch.response && prefetch.response.status !== 'ready') {
    throw new Error(`Prefetch body failed with ${prefetch.response.status}.`);
  }
  const bodies = [
    ...Object.values(visible.response.files),
    ...(prefetch.response?.status === 'ready' ? Object.values(prefetch.response.files) : []),
  ];
  return {
    snapshotMs,
    visibleBodyMs: visible.durationMs,
    prefetchBodyMs: prefetch.durationMs,
    totalMs: performance.now() - startedAt,
    commandCount: trace.length,
    rowCount: bodies.reduce((total, body) => total + body.renderedRowCount, 0),
    patchBytes: bodies.reduce((total, body) => total + body.patchBytes, 0),
  };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function summarize(results: IterationResult[]) {
  const timingKeys = [
    'snapshotMs',
    'visibleBodyMs',
    'prefetchBodyMs',
    'totalMs',
  ] as const;
  return Object.fromEntries(timingKeys.map((key) => {
    const values = results.map((result) => result[key]);
    return [key, {
      median: Number(percentile(values, 0.5).toFixed(2)),
      p95: Number(percentile(values, 0.95).toFixed(2)),
    }];
  }));
}

async function main(): Promise<void> {
  const options = parseGitReviewBenchmarkOptions(process.argv.slice(2));
  const fixture = await createFixture(options.scenario);
  try {
    const results: IterationResult[] = [];
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      results.push(await runIteration(fixture));
    }
    console.log(JSON.stringify({
      scenario: options.scenario,
      iterations: options.iterations,
      timings: summarize(results),
      commandCount: results.map((result) => result.commandCount),
      rowCount: results[0]?.rowCount ?? 0,
      patchBytes: results[0]?.patchBytes ?? 0,
    }, null, 2));
  } finally {
    await fs.rm(fixture.projectPath, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
