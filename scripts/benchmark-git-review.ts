import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { GitRuntime } from '../server/runtime/git/runtime.js';
import type { GitReviewDocumentFileBodiesReady, GitReviewFilePatchBody } from '../common/git.js';

export type GitReviewBenchmarkScenario =
  'revision-24' | 'revision-many' | 'working-tree-many' | 'workbench-many' | 'large-file';

export interface GitReviewBenchmarkOptions {
  scenario: GitReviewBenchmarkScenario;
  iterations: number;
  batchFiles: number;
}

interface BenchmarkFixture {
  projectPath: string;
  fromRevision: string;
  to: { kind: 'revision'; revision: string } | { kind: 'working-tree' };
  surface: 'comparison' | 'workbench';
}

interface IterationResult {
  snapshotMs: number;
  visibleBodyMs: number;
  prefetchBodyMs: number;
  totalMs: number;
  warmSnapshotMs: number;
  tracedCommandCount: number;
  warmTracedCommandCount: number;
  snapshotBytes: number;
  snapshotGzipBytes: number;
  bodyRequests: number;
  bodyBytes: number;
  bodyGzipBytes: number;
  fileCount: number;
  rowCount: number;
  patchBytes: number;
}

const SCENARIOS = new Set<GitReviewBenchmarkScenario>([
  'revision-24',
  'revision-many',
  'working-tree-many',
  'workbench-many',
  'large-file',
]);

export function parseGitReviewBenchmarkOptions(args: string[]): GitReviewBenchmarkOptions {
  let scenario: GitReviewBenchmarkScenario = 'revision-24';
  let iterations = 10;
  let batchFiles = 4;
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
    } else if (argument === '--batch-files') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 24) {
        throw new Error('Batch files must be an integer between 1 and 24.');
      }
      batchFiles = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { scenario, iterations, batchFiles };
}

export function benchmarkScenarioFileNames(scenario: GitReviewBenchmarkScenario): string[] {
  let count = 1;
  if (scenario === 'working-tree-many') count = 240;
  else if (scenario === 'revision-24') count = 24;
  else if (scenario === 'revision-many' || scenario === 'workbench-many') count = 1_000;
  return Array.from({ length: count }, (_, index) =>
    scenario === 'large-file' ? 'large.ts' : `src/file-${String(index).padStart(4, '0')}.ts`,
  );
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
  return (
    Array.from(
      { length: lineCount },
      (_, line) =>
        `export const line${line} = '${changed && (changeEveryLine || line === lineCount - 1) ? 'changed' : 'base'} ${index}:${line}';`,
    ).join('\n') + '\n'
  );
}

export async function createFixture(
  scenario: GitReviewBenchmarkScenario,
): Promise<BenchmarkFixture> {
  const temporary = process.env.TMPDIR ?? path.join(os.homedir(), 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const projectPath = await fs.mkdtemp(path.join(temporary, 'garcon-git-review-bench-'));
  try {
    return await initializeFixture(projectPath, scenario);
  } catch (error) {
    await fs.rm(projectPath, { recursive: true, force: true });
    throw error;
  }
}

async function initializeFixture(
  projectPath: string,
  scenario: GitReviewBenchmarkScenario,
): Promise<BenchmarkFixture> {
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
  if (scenario === 'working-tree-many' || scenario === 'workbench-many') {
    return {
      projectPath,
      fromRevision,
      to: { kind: 'working-tree' },
      surface: scenario === 'workbench-many' ? 'workbench' : 'comparison',
    };
  }
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-q', '-m', 'target']);
  return {
    projectPath,
    fromRevision,
    surface: 'comparison',
    to: {
      kind: 'revision',
      revision: await runGit(projectPath, ['rev-parse', 'HEAD']),
    },
  };
}

export async function runIteration(
  fixture: BenchmarkFixture,
  batchFiles: number,
): Promise<IterationResult> {
  const runtime = new GitRuntime({
    projectBasePath: fixture.projectPath,
    executorId: 'local',
    instanceId: 'benchmark',
    assertAvailable() {},
  });
  try {
    const service = runtime.git;
    const loadSnapshot = () =>
      fixture.surface === 'workbench'
        ? service.getWorkbenchSnapshot({
            projectPath: fixture.projectPath,
            mode: 'working',
            context: 3,
            bodyCandidateCount: 8,
          })
        : service.getComparisonSnapshot({
            projectPath: fixture.projectPath,
            from: { kind: 'revision', revision: fixture.fromRevision },
            to: fixture.to,
            mode: 'direct',
            context: 3,
            bodyCandidateCount: 8,
          });
    const startedAt = performance.now();
    const snapshotStartedAt = performance.now();
    const snapshot = await loadSnapshot();
    const snapshotMs = performance.now() - snapshotStartedAt;
    if (snapshot.status !== 'ready') throw new Error(`Snapshot failed with ${snapshot.status}.`);
    const summary = 'reviewSummary' in snapshot ? snapshot.reviewSummary : snapshot;
    const document = {
      executorId: snapshot.executorId,
      instanceId: snapshot.instanceId,
      documentId: summary.documentId,
    };
    let tracedCommandCount = snapshot.diagnostics?.commands?.length ?? 0;
    const bodyResponses: GitReviewDocumentFileBodiesReady[] = [];
    const loadBodies = async (
      files: string[],
      purpose: 'visible' | 'prefetch',
    ): Promise<GitReviewFilePatchBody[]> => {
      const response = await service.getReviewDocumentFileBodies({
        projectPath: fixture.projectPath,
        document,
        files,
        purpose,
      });
      if (response.status !== 'ready') throw new Error(`Body failed with ${response.status}.`);
      const { diagnostics: _, ...wire } = response;
      bodyResponses.push(wire);
      tracedCommandCount += response.diagnostics?.commands?.length ?? 0;
      const bodies = Object.values(response.files);
      for (const file of response.deferredFiles ?? []) {
        if (files.length === 1) throw new Error('A singleton body was deferred.');
        bodies.push(...(await loadBodies([file], purpose)));
      }
      return bodies;
    };
    const [visiblePath, ...prefetchPaths] = snapshot.firstBodyCandidates;
    if (!visiblePath) throw new Error('Benchmark fixture produced no reviewable files.');

    const visibleStartedAt = performance.now();
    const visiblePromise = loadBodies([visiblePath], 'visible').then((bodies) => ({
      bodies,
      durationMs: performance.now() - visibleStartedAt,
    }));
    const prefetchStartedAt = performance.now();
    const prefetchPromise = (async () => {
      const bodies: GitReviewFilePatchBody[] = [];
      for (let index = 0; index < prefetchPaths.length; index += batchFiles) {
        bodies.push(
          ...(await loadBodies(prefetchPaths.slice(index, index + batchFiles), 'prefetch')),
        );
      }
      return { bodies, durationMs: performance.now() - prefetchStartedAt };
    })();
    const [visible, prefetch] = await Promise.all([visiblePromise, prefetchPromise]);
    const bodies = [...visible.bodies, ...prefetch.bodies];
    const totalMs = performance.now() - startedAt;
    const repeatStarted = performance.now();
    const warmSnapshot = await loadSnapshot();
    const warmSnapshotMs = performance.now() - repeatStarted;
    if (warmSnapshot.status !== 'ready') {
      throw new Error(`Warm snapshot failed with ${warmSnapshot.status}.`);
    }
    const bodyJson = bodyResponses.map(response => JSON.stringify(response));
    const { diagnostics: _, ...wire } = snapshot;
    const json = JSON.stringify(wire);
    return {
      snapshotMs,
      visibleBodyMs: visible.durationMs,
      prefetchBodyMs: prefetch.durationMs,
      totalMs,
      warmSnapshotMs,
      tracedCommandCount,
      warmTracedCommandCount: warmSnapshot.diagnostics?.commands?.length ?? 0,
      snapshotBytes: Buffer.byteLength(json),
      snapshotGzipBytes: gzipSync(json).byteLength,
      bodyRequests: bodyResponses.length,
      bodyBytes: bodyJson.reduce((total, body) => total + Buffer.byteLength(body), 0),
      bodyGzipBytes: bodyJson.reduce((total, body) => total + gzipSync(body).byteLength, 0),
      fileCount: summary.files.length,
      rowCount: bodies.reduce((total, body) => total + body.renderedRowCount, 0),
      patchBytes: bodies.reduce((total, body) => total + body.patchBytes, 0),
    };
  } finally {
    runtime.dispose();
  }
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
    'warmSnapshotMs',
  ] as const;
  return Object.fromEntries(
    timingKeys.map((key) => {
      const values = results.map((result) => result[key]);
      return [
        key,
        {
          median: Number(percentile(values, 0.5).toFixed(2)),
          p95: Number(percentile(values, 0.95).toFixed(2)),
        },
      ];
    }),
  );
}

async function main(): Promise<void> {
  const options = parseGitReviewBenchmarkOptions(process.argv.slice(2));
  const fixture = await createFixture(options.scenario);
  try {
    const results: IterationResult[] = [];
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      results.push(await runIteration(fixture, options.batchFiles));
    }
    console.log(
      JSON.stringify(
        {
          scenario: options.scenario,
          iterations: options.iterations,
          batchFiles: options.batchFiles,
          scope:
            'Validating runtime; cold document registry, warm filesystem; no HTTP or browser. Up to one selected body plus seven queued bodies. Gzip sizes are estimates, not wire measurements.',
          timings: summarize(results),
          tracedCommandCount: results.map((result) => result.tracedCommandCount),
          fileCount: results[0]?.fileCount ?? 0,
          snapshotBytes: results[0]?.snapshotBytes ?? 0,
          snapshotGzipBytes: results[0]?.snapshotGzipBytes ?? 0,
          samples: results,
          rowCount: results[0]?.rowCount ?? 0,
          patchBytes: results[0]?.patchBytes ?? 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(fixture.projectPath, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
