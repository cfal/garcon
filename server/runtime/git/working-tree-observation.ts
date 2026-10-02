import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { mapWithConcurrencyResult } from '../../common/concurrency.js';
import { assertGitWorkingPath } from './operation-context.js';
import { chunkGitPathspecs } from './pathspecs.js';
import {
  hasWorkTreeChange,
  parsePorcelainV1Z
} from './porcelain-status.js';
import {
  readOnlyGitOptions,
  resolvePathWithinProject,
  runGit,
  runGitTraced
} from './run.js';
import type {
  GitCommandTrace,
  GitWorkingTreeFingerprintOptions,
  GitWorkingTreeFingerprintResponse,
  PorcelainStatusEntry
} from './types.js';
import {
  GIT_WORKING_TREE_FINGERPRINT_VERSION
} from './types.js';


export function parseLsFilesStageZ(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of output.split('\0')) {
    if (!token) continue;
    const tabIndex = token.indexOf('\t');
    if (tabIndex < 0) continue;
    const filePath = token.slice(tabIndex + 1);
    if (filePath) map.set(filePath, token);
  }
  return map;
}

function uniqueGitPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean))).sort();
}

async function loadFingerprintIndexEntries(
  projectPath: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const entriesByPath = await loadFingerprintIndexEntryMap(projectPath, paths, signal);
  return Array.from(entriesByPath, ([filePath, entry]) => `${filePath}\x00${entry}`).sort();
}

async function loadFingerprintIndexEntryMap(
  projectPath: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const chunk of chunkGitPathspecs(paths)) {
    try {
      const { stdout } = await runGit(
        projectPath,
        ['ls-files', '-s', '-z', '--', ...chunk],
        readOnlyGitOptions({ signal }),
      );
      for (const [filePath, entry] of parseLsFilesStageZ(stdout)) {
        entries.set(filePath, entry);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Status output still captures the changed path. Missing index metadata should not make freshness fail.
    }
  }
  return entries;
}

async function worktreeStatFingerprint(projectPath: string, file: string): Promise<string> {
  try {
    const filePath = resolvePathWithinProject(projectPath, file);
    await assertGitWorkingPath(filePath);
    const stats = await fs.stat(filePath);
    const kind = stats.isFile() ? 'file' : 'not-file';
    return [
      kind,
      file,
      stats.size,
      Math.trunc(stats.mtimeMs),
      Math.trunc(stats.ctimeMs),
    ].join(':');
  } catch {
    return `missing:${file}`;
  }
}

function shouldStatWorktreeForFingerprint(entry: PorcelainStatusEntry): boolean {
  if (entry.workTreeStatus === 'D') return false;
  if (entry.indexStatus === '?' || entry.workTreeStatus === '?') return true;
  return hasWorkTreeChange(entry.workTreeStatus);
}

async function loadFingerprintWorktreeStats(
  projectPath: string,
  entries: PorcelainStatusEntry[],
): Promise<string[]> {
  const paths = uniqueGitPaths(
    entries
      .filter(shouldStatWorktreeForFingerprint)
      .map((entry) => entry.path),
  );
  return (await mapWithConcurrencyResult(
    paths,
    16,
    (filePath) => worktreeStatFingerprint(projectPath, filePath),
  )).sort();
}

interface WorkbenchFingerprintInput {
  projectPath: string;
  repoRoot: string;
  branch: string;
  head: string;
  statusOutput: string;
  workingStatsOutput: string;
  cachedStatsOutput: string;
  unmergedOutput: string;
  statusEntries: PorcelainStatusEntry[];
  indexEntriesByPath?: Map<string, string>;
  worktreeStatTokens?: string[];
  signal?: AbortSignal;
}

async function buildWorkbenchFingerprintFromInputs({
  projectPath,
  repoRoot,
  branch,
  head,
  statusOutput,
  workingStatsOutput,
  cachedStatsOutput,
  unmergedOutput,
  statusEntries,
  indexEntriesByPath,
  worktreeStatTokens: loadedWorktreeStatTokens,
  signal,
}: WorkbenchFingerprintInput): Promise<{ fingerprint: string; changedPathCount: number }> {
  const changedPaths = uniqueGitPaths(statusEntries.map((entry) => entry.path));
  const [indexEntryTokens, worktreeStatTokens] = await Promise.all([
    indexEntriesByPath
      ? Promise.resolve(
          Array.from(indexEntriesByPath, ([filePath, entry]) => `${filePath}\x00${entry}`).sort(),
        )
      : loadFingerprintIndexEntries(projectPath, changedPaths, signal),
    loadedWorktreeStatTokens
      ? Promise.resolve(loadedWorktreeStatTokens)
      : loadFingerprintWorktreeStats(projectPath, statusEntries),
  ]);

  const digest = createHash('sha256').update([
		`git-working-tree-fingerprint-v${GIT_WORKING_TREE_FINGERPRINT_VERSION}`,
    projectPath,
    repoRoot,
    branch,
    head,
    statusOutput,
    workingStatsOutput,
    cachedStatsOutput,
    unmergedOutput,
    ...indexEntryTokens,
    ...worktreeStatTokens,
  ].join('\x1f')).digest('hex').slice(0, 16);
  const fingerprint = `v${GIT_WORKING_TREE_FINGERPRINT_VERSION}:${digest}`;

  return { fingerprint, changedPathCount: changedPaths.length };
}

export function notRepositoryFingerprint(projectPath: string): GitWorkingTreeFingerprintResponse {
  return {
    status: 'not-git-repository',
    project: projectPath,
    fingerprintVersion: GIT_WORKING_TREE_FINGERPRINT_VERSION,
    fingerprint: null,
    message: 'Git is not initialized in this directory.',
  };
}

export interface GitWorkingTreeObservation {
  projectPath: string;
  repoRoot: string;
  branch: string;
  head: string;
  statusOutput: string;
  workingStatsOutput: string;
  cachedStatsOutput: string;
  unmergedOutput: string;
  statusEntries: PorcelainStatusEntry[];
  changedPaths: string[];
  indexEntriesByPath: Map<string, string>;
  worktreeStatTokens: string[];
  fingerprint: string;
  changedPathCount: number;
}

export class GitWorkingTreeNotRepositoryError extends Error {
  constructor(cause: unknown) {
    super('Git working-tree observation requires a repository.', { cause });
    this.name = 'GitWorkingTreeNotRepositoryError';
  }
}

export async function captureWorkingTreeObservation({
  projectPath,
  repoRoot: knownRepoRoot,
  trace,
  signal,
}: GitWorkingTreeFingerprintOptions & { repoRoot?: string }): Promise<GitWorkingTreeObservation> {
  const [
    repoRootResult,
    branchResult,
    headResult,
    statusResult,
    workingStatsResult,
    cachedStatsResult,
    unmergedResult,
  ] = await Promise.allSettled([
    knownRepoRoot
      ? Promise.resolve({ stdout: knownRepoRoot, stderr: '' })
      : runGitTraced(
          projectPath,
          ['rev-parse', '--show-toplevel'],
          trace,
          readOnlyGitOptions({ signal }),
        ),
    runGitTraced(projectPath, ['branch', '--show-current'], trace, readOnlyGitOptions({ signal })),
    runGitTraced(projectPath, ['rev-parse', 'HEAD'], trace, readOnlyGitOptions({ signal })),
    runGitTraced(
      projectPath,
      ['status', '--porcelain=v1', '-z', '-uall'],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(projectPath, ['diff', '--numstat', '-z'], trace, readOnlyGitOptions({ signal })),
    runGitTraced(
      projectPath,
      ['diff', '--cached', '--numstat', '-z'],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(projectPath, ['ls-files', '-u', '-z'], trace, readOnlyGitOptions({ signal })),
  ]);

  if (repoRootResult.status === 'rejected') {
    if (signal?.aborted) throw repoRootResult.reason;
    throw new GitWorkingTreeNotRepositoryError(repoRootResult.reason);
  }
  if (statusResult.status === 'rejected') throw statusResult.reason;

  const repoRoot = repoRootResult.value.stdout.trim() || projectPath;
  const branch = branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : '';
  const head = headResult.status === 'fulfilled' ? headResult.value.stdout.trim() : '';
  const statusEntries = parsePorcelainV1Z(statusResult.value.stdout);
  const changedPaths = uniqueGitPaths(statusEntries.map((entry) => entry.path));
  const [indexEntriesByPath, worktreeStatTokens] = await Promise.all([
    loadFingerprintIndexEntryMap(projectPath, changedPaths, signal),
    loadFingerprintWorktreeStats(projectPath, statusEntries),
  ]);
  const { fingerprint, changedPathCount } = await buildWorkbenchFingerprintFromInputs({
    projectPath,
    repoRoot,
    branch,
    head,
    statusOutput: statusResult.value.stdout,
    workingStatsOutput: workingStatsResult.status === 'fulfilled' ? workingStatsResult.value.stdout : '',
    cachedStatsOutput: cachedStatsResult.status === 'fulfilled' ? cachedStatsResult.value.stdout : '',
    unmergedOutput: unmergedResult.status === 'fulfilled' ? unmergedResult.value.stdout : '',
    statusEntries,
    indexEntriesByPath,
    worktreeStatTokens,
    signal,
  });

  return {
    projectPath,
    repoRoot,
    branch,
    head,
    statusOutput: statusResult.value.stdout,
    workingStatsOutput: workingStatsResult.status === 'fulfilled' ? workingStatsResult.value.stdout : '',
    cachedStatsOutput: cachedStatsResult.status === 'fulfilled' ? cachedStatsResult.value.stdout : '',
    unmergedOutput: unmergedResult.status === 'fulfilled' ? unmergedResult.value.stdout : '',
    statusEntries,
    changedPaths,
    indexEntriesByPath,
    worktreeStatTokens,
    fingerprint,
    changedPathCount,
  };
}

export async function isWorkingTreeObservationCurrent(
  observation: GitWorkingTreeObservation,
  trace?: GitCommandTrace[],
  signal?: AbortSignal,
): Promise<boolean> {
  const [branchResult, headResult, statusResult, unmergedResult] = await Promise.allSettled([
    runGitTraced(
      observation.projectPath,
      ['branch', '--show-current'],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(
      observation.projectPath,
      ['rev-parse', 'HEAD'],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(
      observation.projectPath,
      ['status', '--porcelain=v1', '-z', '-uall'],
      trace,
      readOnlyGitOptions({ signal }),
    ),
    runGitTraced(
      observation.projectPath,
      ['ls-files', '-u', '-z'],
      trace,
      readOnlyGitOptions({ signal }),
    ),
  ]);
  if (statusResult.status === 'rejected') throw statusResult.reason;

  const branch = branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : '';
  const head = headResult.status === 'fulfilled' ? headResult.value.stdout.trim() : '';
  const unmerged = unmergedResult.status === 'fulfilled' ? unmergedResult.value.stdout : '';
  if (
    branch !== observation.branch ||
    head !== observation.head ||
    statusResult.value.stdout !== observation.statusOutput ||
    unmerged !== observation.unmergedOutput
  ) {
    return false;
  }

  const currentEntries = await loadFingerprintIndexEntryMap(
    observation.projectPath,
    observation.changedPaths,
    signal,
  );
  const currentEntryTokens = Array.from(
    currentEntries,
    ([filePath, entry]) => `${filePath}\x00${entry}`,
  ).sort();
  const expectedEntryTokens = Array.from(
    observation.indexEntriesByPath,
    ([filePath, entry]) => `${filePath}\x00${entry}`,
  ).sort();
  if (currentEntryTokens.join('\x1f') !== expectedEntryTokens.join('\x1f')) return false;

  const currentWorktreeStats = await loadFingerprintWorktreeStats(
    observation.projectPath,
    observation.statusEntries,
  );
  return currentWorktreeStats.join('\x1f') === observation.worktreeStatTokens.join('\x1f');
}

export async function getWorkingTreeFingerprint({
  projectPath,
  trace,
  signal,
}: GitWorkingTreeFingerprintOptions): Promise<GitWorkingTreeFingerprintResponse> {
  try {
    await fs.access(projectPath);
  } catch {
    return notRepositoryFingerprint(projectPath);
  }

  let observation: GitWorkingTreeObservation;
  try {
    observation = await captureWorkingTreeObservation({ projectPath, trace, signal });
  } catch (error) {
    if (error instanceof GitWorkingTreeNotRepositoryError) {
      return notRepositoryFingerprint(projectPath);
    }
    throw error;
  }

  return {
    status: 'ready',
    project: projectPath,
    fingerprintVersion: GIT_WORKING_TREE_FINGERPRINT_VERSION,
    fingerprint: observation.fingerprint,
    changedPathCount: observation.changedPathCount,
  };
}
