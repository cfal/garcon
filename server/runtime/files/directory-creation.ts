import { constants, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DomainError } from '../../common/domain-error.js';
import { fileRevisionConflict } from './errors.js';

// Linux names an open descriptor by a path the kernel resolves to the pinned
// directory itself, without walking the directory's original path again.
const LINUX_DESCRIPTOR_PATHS = '/proc/self/fd';

/**
 * Returns the directory whose entries name this process's open descriptors, or
 * null where the system has none. Creating a directory safely needs one: this
 * runtime has no descriptor-relative mkdir, and a path-based mkdir can be
 * redirected outside the project base by swapping a path component for a link.
 */
export function descriptorPathsDirectory(): string | null {
  return process.platform === 'linux' && existsSync(LINUX_DESCRIPTOR_PATHS) ? LINUX_DESCRIPTOR_PATHS : null;
}

export function directoryCreationUnsupported(): DomainError {
  return new DomainError('OPERATION_UNSUPPORTED', 'This executor cannot create directories', 501);
}

/**
 * Creates one child of `parent`, the canonical path of a validated directory,
 * and returns the child's path. The parent is opened and the child is created
 * through that descriptor, so replacing a path component with a link after
 * validation cannot redirect the creation. There is no path-based fallback.
 */
export async function createChildDirectory(descriptorPaths: string, parent: string, name: string): Promise<string> {
  // A system that turns out not to name open descriptors creates nothing.
  await fs.access(descriptorPaths).catch(() => { throw directoryCreationUnsupported(); });
  const handle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = `${descriptorPaths}/${handle.fd}`;
    // The kernel reports where the opened directory is now. Anything but the
    // validated path means a component changed between validation and opening.
    if (await fs.readlink(pinned) !== parent) throw fileRevisionConflict();
    await fs.mkdir(`${pinned}/${name}`);
    return path.join(parent, name);
  } finally { await handle.close(); }
}
