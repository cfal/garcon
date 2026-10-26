import { promises as fs } from 'fs';
import {
  type GitCommandTrace,
  type GitQuickSummaryOptions,
  type GitQuickSummaryResponse,
  type NumstatMap,
} from './types.js';
import {
  readOnlyGitOptions,
  runGitTraced,
} from './run.js';
import { parseNumstatZ } from './diff-file-list.js';
import { parsePorcelainV1Z } from './porcelain-status.js';

const DIFF_STATS_TIMEOUT_MS = 2_000;
const DIFF_STATS_MAX_BYTES = 1024 * 1024;

export function notRepositoryQuickSummary(projectPath: string): GitQuickSummaryResponse {
  return {
    status: 'not-git-repository',
    project: projectPath,
    message: 'Git is not initialized in this directory.',
  };
}

function unknownSummary(projectPath: string, message: string): GitQuickSummaryResponse {
  return {
    status: 'unknown',
    project: projectPath,
    message,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sumStats(stats: NumstatMap): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const entry of Object.values(stats)) {
    additions += entry.additions;
    deletions += entry.deletions;
  }
  return { additions, deletions };
}

function firstDetachedRefLabel(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/HEAD'))[0] ?? '';
}

async function resolveBranchLabel(
  projectPath: string,
  head: string,
  hasCommits: boolean,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
  run = runGitTraced,
): Promise<string> {
  try {
    const { stdout } = await run(
      projectPath,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      trace,
      readOnlyGitOptions({ signal }),
    );
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    // Detached HEAD and unborn edge cases fall through to stable labels.
  }

  if (!hasCommits) return 'main';

  try {
    const { stdout } = await run(
      projectPath,
      [
        'for-each-ref',
        '--format=%(refname:short)',
        '--points-at',
        'HEAD',
        'refs/remotes',
        'refs/tags',
      ],
      trace,
      readOnlyGitOptions({ signal }),
    );
    const label = firstDetachedRefLabel(stdout);
    if (label) return label;
  } catch {
    // Unknown detached refs fall through to a short SHA.
  }

  try {
    const { stdout } = await run(
      projectPath,
      ['rev-parse', '--short', 'HEAD'],
      trace,
      readOnlyGitOptions({ signal }),
    );
    return stdout.trim() || head.slice(0, 7) || 'HEAD';
  } catch {
    return head.slice(0, 7) || 'HEAD';
  }
}

export function createQuickSummaryOperations(run = runGitTraced) {
  async function getQuickSummary({
    projectPath,
    trace,
    signal,
  }: GitQuickSummaryOptions): Promise<GitQuickSummaryResponse> {
    signal?.throwIfAborted();
    try {
      await fs.access(projectPath);
    } catch {
      return notRepositoryQuickSummary(projectPath);
    }

    const [
      repositoryResult,
      headResult,
      statusResult,
    ] = await Promise.allSettled([
      run(projectPath, ['rev-parse', '--show-toplevel'], trace, readOnlyGitOptions({ signal })),
      run(projectPath, ['rev-parse', '--verify', 'HEAD'], trace, readOnlyGitOptions({ signal })),
      run(
        projectPath,
        ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
        trace,
        readOnlyGitOptions({ signal }),
      ),
    ]);

    signal?.throwIfAborted();
    if (repositoryResult.status === 'rejected') return notRepositoryQuickSummary(projectPath);
    if (statusResult.status === 'rejected') {
      return unknownSummary(projectPath, errorText(statusResult.reason));
    }

    const head = headResult.status === 'fulfilled' ? headResult.value.stdout.trim() : '';
    const hasCommits = headResult.status === 'fulfilled';
    const entries = parsePorcelainV1Z(statusResult.value.stdout);
    const hasTrackedChanges = entries.some((entry) => entry.indexStatus !== '?');
    const [branch, diffStats] = await Promise.all([
      resolveBranchLabel(projectPath, head, hasCommits, trace, signal, run),
      hasTrackedChanges ? collectDiffStats(projectPath, trace, signal, run) : { additions: 0, deletions: 0 },
    ]);
    signal?.throwIfAborted();

    return {
      status: 'ready',
      project: projectPath,
      branch,
      hasChanges: entries.length > 0,
      hasUntracked: entries.some((entry) => entry.indexStatus === '?'),
      diffStats,
    };
  }

  return { getQuickSummary };
}

async function collectDiffStats(
  projectPath: string,
  trace: GitCommandTrace[] | undefined,
  signal: AbortSignal | undefined,
  run: typeof runGitTraced,
): Promise<{ additions: number; deletions: number } | null> {
  // Optional totals must not hold branch/change presence behind a costly diff or external filter.
  const options = readOnlyGitOptions({
    signal,
    timeoutMs: DIFF_STATS_TIMEOUT_MS,
    maxStdoutBytes: DIFF_STATS_MAX_BYTES,
  });
  const results = await Promise.allSettled([
    run(projectPath, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv'], trace, options),
    run(projectPath, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv'], trace, options),
  ]);
  signal?.throwIfAborted();
  let additions = 0;
  let deletions = 0;
  for (const result of results) {
    if (result.status === 'rejected') return null;
    const totals = sumStats(parseNumstatZ(result.value.stdout));
    additions += totals.additions;
    deletions += totals.deletions;
  }
  return { additions, deletions };
}
