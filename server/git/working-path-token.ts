import { promises as fs } from 'fs';
import { chunkGitPathspecs } from './pathspecs.js';
import { parsePorcelainV1Z } from './porcelain-status.js';
import { readOnlyGitOptions, resolvePathWithinProject, runGit } from './run.js';
import type { PorcelainStatusEntry } from './types.js';

export interface GitWorkingPathToken {
  path: string;
  indexEntry: string | null;
  status: string;
  worktreeKind: 'missing' | 'file' | 'symlink' | 'directory' | 'other';
  worktreeSize: string | null;
  worktreeMtimeNs: string | null;
  worktreeCtimeNs: string | null;
}

interface WorkingPathTokenInputs {
  statusEntries?: PorcelainStatusEntry[];
  indexEntriesByPath?: Map<string, string>;
  scope?: 'working-tree' | 'index';
}

function parseIndexEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const token of output.split('\0')) {
    if (!token) continue;
    const tabIndex = token.indexOf('\t');
    if (tabIndex < 0) continue;
    entries.set(token.slice(tabIndex + 1), token);
  }
  return entries;
}

function statusToken(entry: PorcelainStatusEntry | undefined): string {
  if (!entry) return '  ';
  return `${entry.indexStatus}${entry.workTreeStatus}\0${entry.originalPath ?? ''}`;
}

async function worktreeToken(
  projectPath: string,
  filePath: string,
): Promise<Omit<GitWorkingPathToken, 'path' | 'indexEntry' | 'status'>> {
  try {
    const stats = await fs.lstat(resolvePathWithinProject(projectPath, filePath), { bigint: true });
    const worktreeKind = stats.isFile()
      ? 'file'
      : stats.isSymbolicLink()
        ? 'symlink'
        : stats.isDirectory()
          ? 'directory'
          : 'other';
    return {
      worktreeKind,
      worktreeSize: stats.size.toString(),
      worktreeMtimeNs: stats.mtimeNs.toString(),
      worktreeCtimeNs: stats.ctimeNs.toString(),
    };
  } catch {
    return {
      worktreeKind: 'missing',
      worktreeSize: null,
      worktreeMtimeNs: null,
      worktreeCtimeNs: null,
    };
  }
}

export async function captureWorkingPathTokens(
  projectPath: string,
  paths: string[],
  inputs: WorkingPathTokenInputs = {},
  signal?: AbortSignal,
): Promise<Map<string, GitWorkingPathToken>> {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean))).sort();
  const scope = inputs.scope ?? 'working-tree';
  let indexEntriesByPath = inputs.indexEntriesByPath;
  let statusEntries = inputs.statusEntries;

  if (!indexEntriesByPath || !statusEntries) {
    const loadedIndexEntries = new Map<string, string>();
    const loadedStatusEntries: PorcelainStatusEntry[] = [];
    for (const chunk of chunkGitPathspecs(uniquePaths)) {
      const [index, status] = await Promise.all([
        indexEntriesByPath
          ? Promise.resolve(null)
          : runGit(
              projectPath,
              ['ls-files', '-s', '-z', '--', ...chunk],
              readOnlyGitOptions({ signal }),
            ),
        statusEntries
          ? Promise.resolve(null)
          : runGit(
              projectPath,
              ['status', '--porcelain=v1', '-z', '--', ...chunk],
              readOnlyGitOptions({ signal }),
            ),
      ]);
      if (index) {
        for (const [path, entry] of parseIndexEntries(index.stdout)) {
          loadedIndexEntries.set(path, entry);
        }
      }
      if (status) loadedStatusEntries.push(...parsePorcelainV1Z(status.stdout));
    }
    indexEntriesByPath ??= loadedIndexEntries;
    statusEntries ??= loadedStatusEntries;
  }

  const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry]));
  const tokens = await Promise.all(
    uniquePaths.map(async (path) => ({
      path,
      indexEntry: indexEntriesByPath?.get(path) ?? null,
      status:
        scope === 'index'
          ? `${statusToken(statusByPath.get(path)).slice(0, 1)} \0`
          : statusToken(statusByPath.get(path)),
      ...(scope === 'index'
        ? {
            worktreeKind: 'missing' as const,
            worktreeSize: null,
            worktreeMtimeNs: null,
            worktreeCtimeNs: null,
          }
        : await worktreeToken(projectPath, path)),
    })),
  );
  return new Map(tokens.map((token) => [token.path, token]));
}

export function changedWorkingPathTokens(
  expected: ReadonlyMap<string, GitWorkingPathToken>,
  actual: ReadonlyMap<string, GitWorkingPathToken>,
): string[] {
  const changed: string[] = [];
  for (const [path, token] of expected) {
    const current = actual.get(path);
    if (!current || JSON.stringify(current) !== JSON.stringify(token)) changed.push(path);
  }
  return changed;
}
