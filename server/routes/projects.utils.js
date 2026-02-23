import { promises as fs } from 'fs';
import path from 'path';

function permToRwx(perm) {
  return `${perm & 4 ? 'r' : '-'}${perm & 2 ? 'w' : '-'}${perm & 1 ? 'x' : '-'}`;
}

export async function listDirectory(dirPath, showHidden = true) {
  const skipNames = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg']);
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') {
      console.error('Error reading directory:', error);
    }
    return [];
  }

  const filtered = entries.filter((entry) => {
    if (skipNames.has(entry.name)) return false;
    if (!showHidden && entry.name.startsWith('.')) return false;
    return true;
  });

  const items = await Promise.all(filtered.map(async (entry) => {
    const itemPath = path.join(dirPath, entry.name);
    const isDir = entry.isDirectory();
    const item = {
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
