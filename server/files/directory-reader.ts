import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExecutionFileEntry } from '@garcon/server-agent-interface';
import type { FileTreeBreadcrumb, FileTreeEntry } from '../../common/file-contracts.js';
import { DomainError } from '../lib/domain-error.js';
import { resolveRealWithinCanonicalBase } from '../lib/path-boundary.js';
import { toNodePath } from '../execution-nodes/node-path.js';

const MAX_ENTRIES = 10_000;
const MAX_LIST_BYTES = 1024 * 1024;
const SKIP_NAMES = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg']);

export function relativeFilePath(root: string, target: string): string {
  return toNodePath(path.relative(root, target));
}

export function fileBreadcrumbs(root: string, target: string): FileTreeBreadcrumb[] {
  const result = [{ name: path.basename(root) || root, path: toNodePath(root) }];
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    result.push({ name: segment, path: toNodePath(current) });
  }
  return result;
}

function permissions(mode: number): string {
  return [6, 3, 0].map((shift) => {
    const bits = (mode >> shift) & 7;
    return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
  }).join('');
}

export async function readFileDirectory(root: string, directory: string, signal?: AbortSignal): Promise<FileTreeEntry[]> {
  const entries: FileTreeEntry[] = [];
  let bytes = 0;
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    signal?.throwIfAborted();
    const candidate = path.join(directory, entry.name);
    let stat;
    try {
      await resolveRealWithinCanonicalBase(root, candidate);
      stat = await fs.stat(candidate);
    } catch { continue; }
    if (!stat.isFile() && !stat.isDirectory()) continue;
    const item: FileTreeEntry = {
      name: entry.name, path: toNodePath(candidate), relativePath: relativeFilePath(root, candidate),
      type: stat.isDirectory() ? 'directory' : 'file', size: stat.size,
      modified: stat.mtime.toISOString(), permissionsRwx: permissions(stat.mode),
    };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (entries.length >= MAX_ENTRIES || bytes > MAX_LIST_BYTES) {
      throw new DomainError('FILE_LIST_TOO_LARGE', 'Directory contains too many entries to display', 413);
    }
    entries.push(item);
  }
  return entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
}

export async function listProjectFiles(root: string, signal?: AbortSignal): Promise<{ files: ExecutionFileEntry[]; truncated: boolean }> {
  const files: ExecutionFileEntry[] = [];
  let bytes = 0;
  let visited = 0;
  let truncated = false;
  async function visit(directory: string, depth: number): Promise<void> {
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      signal?.throwIfAborted();
      if (truncated) return;
      if (++visited > MAX_ENTRIES * 4) { truncated = true; return; }
      if (SKIP_NAMES.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 10) {
        await resolveRealWithinCanonicalBase(root, candidate);
        await visit(candidate, depth + 1);
      } else if (entry.isFile()) {
        const item: ExecutionFileEntry = { name: entry.name, path: toNodePath(candidate), relativePath: relativeFilePath(root, candidate), type: 'file' };
        const length = Buffer.byteLength(JSON.stringify(item));
        if (files.length >= MAX_ENTRIES || bytes + length > MAX_LIST_BYTES) { truncated = true; return; }
        bytes += length;
        files.push(item);
      }
    }
  }
  await visit(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

export function directoryCandidates(entries: readonly FileTreeEntry[]): ExecutionFileEntry[] {
  return entries.filter((entry) => entry.type === 'directory' && !SKIP_NAMES.has(entry.name))
    .map(({ name, path: itemPath }) => ({ name, path: itemPath, type: 'directory' }));
}
