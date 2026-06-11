import { promises as fs } from 'fs';
import path from 'path';

export interface DirectoryListItem {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  modified?: string | null;
  permissions?: string;
  permissionsRwx?: string;
}

export interface DirectoryNameItem {
  name: string;
  path: string;
  type: 'directory';
}

const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg']);

function permToRwx(perm: number): string {
  return `${perm & 4 ? 'r' : '-'}${perm & 2 ? 'w' : '-'}${perm & 1 ? 'x' : '-'}`;
}

function isAccessDeniedError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && ((error as { code?: unknown }).code === 'EACCES' || (error as { code?: unknown }).code === 'EPERM'),
  );
}

export async function listDirectory(dirPath: string, showHidden = true): Promise<DirectoryListItem[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (!isAccessDeniedError(error)) {
      console.error('Error reading directory:', error);
    }
    return [];
  }

  const filtered = entries.filter((entry) => {
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) return false;
    if (!showHidden && entry.name.startsWith('.')) return false;
    return true;
  });

  const items = await Promise.all(filtered.map(async (entry) => {
    const itemPath = path.join(dirPath, entry.name);
    const isDir = entry.isDirectory();
    const item: DirectoryListItem = {
      name: entry.name,
      path: itemPath,
      type: isDir ? 'directory' : 'file',
    };

    try {
      const stats = await fs.stat(itemPath);
      item.size = stats.size;
      item.modified = stats.mtime.toISOString();
      const mode = stats.mode;
      const ownerPerm = (mode >> 6) & 7;
      const groupPerm = (mode >> 3) & 7;
      const otherPerm = mode & 7;
      item.permissions = `${ownerPerm}${groupPerm}${otherPerm}`;
      item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
    } catch {
      item.size = 0;
      item.modified = null;
      item.permissions = '000';
      item.permissionsRwx = '---------';
    }
    return item;
  }));

  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function listDirectoryNames(dirPath: string, showHidden = true): Promise<DirectoryNameItem[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (!isAccessDeniedError(error)) {
      console.error('Error reading directory:', error);
    }
    return [];
  }

  const items: DirectoryNameItem[] = [];
  for (const entry of entries) {
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
    if (!showHidden && entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue;
    items.push({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      type: 'directory',
    });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}
