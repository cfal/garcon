import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import {
  GIT_QUICK_SUMMARY_FINGERPRINT_VERSION,
  type GitCommandTrace,
  type GitQuickSummaryOptions,
  type GitQuickSummaryResponse,
  type NumstatMap,
  type PorcelainStatusEntry,
} from './types.js';
import {
  runGitTraced,
} from './run.js';
import { parseNumstatZ } from './diff-file-list.js';
import {
  hasIndexChange,
  hasWorkTreeChange,
  parsePorcelainV1Z,
} from './porcelain-status.js';

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function notRepository(projectPath: string): GitQuickSummaryResponse {
  return {
    status: 'not-git-repository',
    project: projectPath,
    fingerprintVersion: GIT_QUICK_SUMMARY_FINGERPRINT_VERSION,
    fingerprint: null,
    message: 'Git is not initialized in this directory.',
  };
}

function unknownSummary(projectPath: string, message: string): GitQuickSummaryResponse {
  return {
    status: 'unknown',
    project: projectPath,
    fingerprintVersion: GIT_QUICK_SUMMARY_FINGERPRINT_VERSION,
    fingerprint: null,
    message,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanPath(filePath: string): string {
  return filePath.replace(/\/+$/g, '');
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

function hasUnstagedChange(entry: PorcelainStatusEntry): boolean {
  return entry.indexStatus === '?' || hasWorkTreeChange(entry.workTreeStatus);
}

async function resolveBranchLabel(
  projectPath: string,
  head: string,
  hasCommits: boolean,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await runGitTraced(
      projectPath,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      trace,
      { signal },
    );
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    // Detached HEAD and unborn edge cases fall through to stable labels.
  }

  if (!hasCommits) return 'main';

  try {
    const { stdout } = await runGitTraced(projectPath, ['rev-parse', '--short', 'HEAD'], trace, {
      signal,
    });
    return stdout.trim() || head.slice(0, 7) || 'HEAD';
  } catch {
    return head.slice(0, 7) || 'HEAD';
  }
}

export function createQuickSummaryOperations() {
  async function getQuickSummary({
    projectPath,
    trace,
    signal,
  }: GitQuickSummaryOptions): Promise<GitQuickSummaryResponse> {
    try {
      await fs.access(projectPath);
    } catch {
      return notRepository(projectPath);
    }

    const [
      repoRootResult,
      headResult,
      statusResult,
      workingStatsResult,
      cachedStatsResult,
      unmergedResult,
    ] = await Promise.allSettled([
      runGitTraced(projectPath, ['rev-parse', '--show-toplevel'], trace, { signal }),
      runGitTraced(projectPath, ['rev-parse', '--verify', 'HEAD'], trace, { signal }),
      runGitTraced(projectPath, ['status', '--porcelain=v1', '-z', '-uall'], trace, { signal }),
      runGitTraced(projectPath, ['diff', '--numstat', '-z'], trace, { signal }),
      runGitTraced(projectPath, ['diff', '--cached', '--numstat', '-z'], trace, { signal }),
      runGitTraced(projectPath, ['ls-files', '-u', '-z'], trace, { signal }),
    ]);

    if (repoRootResult.status === 'rejected') return notRepository(projectPath);
    if (statusResult.status === 'rejected') {
      return unknownSummary(projectPath, errorText(statusResult.reason));
    }

    const repoRoot = repoRootResult.value.stdout.trim() || projectPath;
    const head = headResult.status === 'fulfilled' ? headResult.value.stdout.trim() : '';
    const hasCommits = headResult.status === 'fulfilled';
    const branch = await resolveBranchLabel(projectPath, head, hasCommits, trace, signal);
    const statusOutput = statusResult.value.stdout;
    const statusEntries = parsePorcelainV1Z(statusOutput).map((entry) => ({
      ...entry,
      path: cleanPath(entry.path),
    }));
    const workingStatsOutput =
      workingStatsResult.status === 'fulfilled' ? workingStatsResult.value.stdout : '';
    const cachedStatsOutput =
      cachedStatsResult.status === 'fulfilled' ? cachedStatsResult.value.stdout : '';
    const unmergedOutput = unmergedResult.status === 'fulfilled' ? unmergedResult.value.stdout : '';
    const workingStats = parseNumstatZ(workingStatsOutput);
    const cachedStats = parseNumstatZ(cachedStatsOutput);
    const workingTotals = sumStats(workingStats);
    const cachedTotals = sumStats(cachedStats);

    const changedPaths = new Set<string>();
    const trackedChangedPaths = new Set<string>();
    const untrackedPaths = new Set<string>();
    const stagedPaths = new Set<string>();
    const unstagedPaths = new Set<string>();

    for (const entry of statusEntries) {
      if (!entry.path) continue;
      changedPaths.add(entry.path);
      if (entry.indexStatus === '?') {
        untrackedPaths.add(entry.path);
      } else {
        trackedChangedPaths.add(entry.path);
      }
      if (hasIndexChange(entry.indexStatus)) stagedPaths.add(entry.path);
      if (hasUnstagedChange(entry)) unstagedPaths.add(entry.path);
    }

    const fingerprint = `v${GIT_QUICK_SUMMARY_FINGERPRINT_VERSION}:${hashString([
      `git-quick-summary-v${GIT_QUICK_SUMMARY_FINGERPRINT_VERSION}`,
      projectPath,
      repoRoot,
      branch,
      head,
      statusOutput,
      workingStatsOutput,
      cachedStatsOutput,
      unmergedOutput,
    ].join('\x1f'))}`;

    return {
      status: 'ready',
      project: projectPath,
      repoRoot,
      branch,
      hasCommits,
      changedFiles: changedPaths.size,
      trackedChangedFiles: trackedChangedPaths.size,
      untrackedFiles: untrackedPaths.size,
      stagedFiles: stagedPaths.size,
      unstagedFiles: unstagedPaths.size,
      additions: workingTotals.additions + cachedTotals.additions,
      deletions: workingTotals.deletions + cachedTotals.deletions,
      fingerprintVersion: GIT_QUICK_SUMMARY_FINGERPRINT_VERSION,
      fingerprint,
    };
  }

  return { getQuickSummary };
}
