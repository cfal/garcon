import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { hasNodeErrorCode } from '../../common/errors.js';
import { assertRealWithinBase } from '../../common/path-boundary.js';
import { fileRevisionConflict } from './errors.js';

// Linux names an open descriptor by a path the kernel resolves to the pinned
// directory itself, without walking the directory's original path again.
const DESCRIPTOR_PATHS = '/proc/self/fd';

/**
 * Creates one child of `parent`, the canonical path of a directory inside
 * `root`, and returns the child's path. On Linux the parent is opened and the
 * child is created through that descriptor, so replacing a path component with
 * a link after validation cannot redirect the creation. Other platforms cannot
 * create relative to a descriptor; there the parent is resolved again
 * immediately before creating, which narrows that window without closing it.
 */
export async function createChildDirectory(root: string, parent: string, name: string): Promise<string> {
  const target = path.join(parent, name);
  if (process.platform === 'linux' && await createThroughDescriptor(parent, name)) return target;
  if (await assertRealWithinBase(root, parent) !== parent) throw fileRevisionConflict();
  await fs.mkdir(target);
  return target;
}

// Reports false when this system has no descriptor paths to create through.
async function createThroughDescriptor(parent: string, name: string): Promise<boolean> {
  const handle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = `${DESCRIPTOR_PATHS}/${handle.fd}`;
    let location: string;
    try { location = await fs.readlink(pinned); }
    catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
    // The kernel reports where the opened directory is now. Anything but the
    // validated path means a component changed between validation and opening.
    if (location !== parent) throw fileRevisionConflict();
    await fs.mkdir(`${pinned}/${name}`);
    return true;
  } finally { await handle.close(); }
}
