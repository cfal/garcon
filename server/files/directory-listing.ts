import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkspaceDirectoryEntry, WorkspaceFileList } from '../execution-nodes/workspace-files.js';
import { mapWithConcurrencyResult } from '../lib/concurrency.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('files:directory-listing');
const DIRECTORY_METADATA_CONCURRENCY = 16;
const FILE_LIST_MAX_DEPTH = 10;
const FILE_LIST_MAX_RESULTS = 10_000;
const SKIP_DIRECTORY_NAMES = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg']);

export interface DirectoryListItem {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly size: number;
  readonly modified: string | null;
  readonly permissionsRwx: string;
}

function permToRwx(perm: number): string {
  return `${perm & 4 ? 'r' : '-'}${perm & 2 ? 'w' : '-'}${perm & 1 ? 'x' : '-'}`;
}

export async function listDirectoryStrict(dirPath: string, signal: AbortSignal): Promise<DirectoryListItem[]> {
  signal.throwIfAborted();
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const items = await mapWithConcurrencyResult(entries, DIRECTORY_METADATA_CONCURRENCY, async (entry) => {
    signal.throwIfAborted();
    const itemPath = path.join(dirPath, entry.name);
    try {
      const stats = await fs.stat(itemPath);
      signal.throwIfAborted();
      return {
        name: entry.name, path: itemPath, type: stats.isDirectory() ? 'directory' as const : 'file' as const,
        size: stats.size, modified: stats.mtime.toISOString(),
        permissionsRwx: permToRwx((stats.mode >> 6) & 7) + permToRwx((stats.mode >> 3) & 7) + permToRwx(stats.mode & 7),
      };
    } catch {
      signal.throwIfAborted();
      return {
        name: entry.name, path: itemPath, type: entry.isDirectory() ? 'directory' as const : 'file' as const,
        size: 0, modified: null, permissionsRwx: '---------',
      };
    }
  });
  signal.throwIfAborted();
  return items.sort((a, b) => a.type !== b.type
    ? a.type === 'directory' ? -1 : 1
    : a.name.localeCompare(b.name));
}

export async function listDirectoryNames(dirPath: string, signal: AbortSignal): Promise<WorkspaceDirectoryEntry[]> {
  signal.throwIfAborted();
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    signal.throwIfAborted();
    if (!hasNodeErrorCode(error, 'EACCES') && !hasNodeErrorCode(error, 'EPERM')) {
      logger.error('Error reading directory:', error);
    }
    return [];
  }
  signal.throwIfAborted();
  return entries
    .filter((entry) => !SKIP_DIRECTORY_NAMES.has(entry.name) && entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(dirPath, entry.name), type: 'directory' as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listWorkspaceFiles(dirPath: string, signal: AbortSignal): Promise<WorkspaceFileList> {
  const files: WorkspaceFileList['files'][number][] = [];
  const pending = [{ dirPath, depth: 0 }];
  let truncated = false;
  while (pending.length > 0) {
    signal.throwIfAborted();
    const current = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current.dirPath, { withFileTypes: true });
    } catch {
      signal.throwIfAborted();
      continue;
    }
    signal.throwIfAborted();
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      const itemPath = path.join(current.dirPath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < FILE_LIST_MAX_DEPTH) pending.push({ dirPath: itemPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= FILE_LIST_MAX_RESULTS) {
        truncated = true;
        pending.length = 0;
        break;
      }
      files.push({
        name: entry.name, path: itemPath,
        relativePath: path.relative(dirPath, itemPath).split(path.sep).join('/'), type: 'file',
      });
    }
  }
  return { files, truncated };
}
