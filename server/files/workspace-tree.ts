import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileTreeBreadcrumb, FileTreeEntry, FileTreeHomeDirectory, FileTreeResponse } from '../../common/file-contracts.js';
import { FileTreeDirectoryRequiredError, type WorkspaceDirectoryEntry } from '../execution-nodes/workspace-files.js';
import { mapWithConcurrencyResult } from '../lib/concurrency.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { isProjectBoundaryError, resolveRealWithinCanonicalBase } from '../lib/path-boundary.js';
import { listDirectoryNames, listDirectoryStrict } from './directory-listing.js';

const FILE_TREE_CONTAINMENT_CONCURRENCY = 16;

function portableRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join('/');
}

function breadcrumbs(rootPath: string, targetPath: string): FileTreeBreadcrumb[] {
  const result = [{ name: path.basename(rootPath) || rootPath, path: rootPath }];
  let currentPath = rootPath;
  for (const segment of path.relative(rootPath, targetPath).split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    result.push({ name: segment, path: currentPath });
  }
  return result;
}

function isOmittableEntryError(error: unknown): boolean {
  return isProjectBoundaryError(error) || ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM']
    .some((code) => hasNodeErrorCode(error, code));
}

async function homeDirectory(root: string, home: string | null, signal: AbortSignal): Promise<FileTreeHomeDirectory | null> {
  if (!home) return null;
  try {
    const resolved = await resolveRealWithinCanonicalBase(root, home);
    signal.throwIfAborted();
    if (!(await fs.stat(resolved)).isDirectory()) return null;
    signal.throwIfAborted();
    return { path: resolved, breadcrumbs: breadcrumbs(root, resolved) };
  } catch {
    signal.throwIfAborted();
    // Optional Home discovery never discloses paths or blocks the tree.
    return null;
  }
}

export async function readWorkspaceTree(
  root: string,
  home: string | null,
  requestedPath: string | null,
  signal: AbortSignal,
  listTreeDirectory = listDirectoryStrict,
): Promise<FileTreeResponse> {
  signal.throwIfAborted();
  const directoryPath = await resolveRealWithinCanonicalBase(root, requestedPath || root);
  signal.throwIfAborted();
  if (!(await fs.stat(directoryPath)).isDirectory()) throw new FileTreeDirectoryRequiredError();
  const homePath = await homeDirectory(root, home, signal);
  signal.throwIfAborted();
  const listed = await listTreeDirectory(directoryPath, signal);
  signal.throwIfAborted();
  const resolved = await mapWithConcurrencyResult(listed, FILE_TREE_CONTAINMENT_CONCURRENCY, async (entry) => {
    signal.throwIfAborted();
    try {
      await resolveRealWithinCanonicalBase(root, entry.path);
      signal.throwIfAborted();
      return { ...entry, relativePath: portableRelativePath(root, entry.path) };
    } catch (error) {
      signal.throwIfAborted();
      if (isOmittableEntryError(error)) return null;
      throw error;
    }
  });
  const entries: FileTreeEntry[] = [];
  for (const entry of resolved) if (entry) entries.push(entry);
  return {
    fileRootPath: root,
    homeDirectory: homePath,
    directory: {
      path: directoryPath, relativePath: portableRelativePath(root, directoryPath),
      parentPath: directoryPath === root ? null : path.dirname(directoryPath),
      breadcrumbs: breadcrumbs(root, directoryPath),
    },
    entries,
  };
}

export async function browseWorkspaceDirectories(root: string, requestedPath: string | null, signal: AbortSignal): Promise<WorkspaceDirectoryEntry[]> {
  signal.throwIfAborted();
  try {
    const directory = await resolveRealWithinCanonicalBase(root, requestedPath || root);
    signal.throwIfAborted();
    await fs.access(directory);
    signal.throwIfAborted();
    const entries = await listDirectoryNames(directory, signal);
    const safeEntries: WorkspaceDirectoryEntry[] = [];
    for (const entry of entries) {
      signal.throwIfAborted();
      try {
        await resolveRealWithinCanonicalBase(root, entry.path);
        safeEntries.push(entry);
      } catch {
        signal.throwIfAborted();
      }
    }
    signal.throwIfAborted();
    return safeEntries;
  } catch {
    signal.throwIfAborted();
    return [];
  }
}
