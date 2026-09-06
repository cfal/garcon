import { constants, promises as fs } from 'node:fs';
import type {
  ProjectResolution,
  ProjectUnavailableReason,
} from '../../common/project-resolution.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import {
  assertRealWithinProjectBase,
  isProjectBoundaryError,
} from '../lib/path-boundary.js';

export async function inspectProjectDirectory(
  projectPath: string,
  {
    resolvePath = assertRealWithinProjectBase,
    stat = fs.stat,
    access = fs.access,
  }: {
    resolvePath?: typeof assertRealWithinProjectBase;
    stat?: typeof fs.stat;
    access?: typeof fs.access;
  } = {},
): Promise<ProjectResolution> {
  if (!projectPath.trim()) return { kind: 'unavailable', reason: 'not-found' };

  try {
    const canonical = await resolvePath(projectPath);
    const status = await stat(canonical);
    if (!status.isDirectory()) return { kind: 'unavailable', reason: 'not-a-directory' };
    await access(canonical, constants.R_OK | constants.X_OK);
    return { kind: 'available', effectiveProjectKey: canonical };
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason) return { kind: 'unavailable', reason };
    throw error;
  }
}

function unavailableReason(error: unknown): ProjectUnavailableReason | null {
  if (isProjectBoundaryError(error)) return 'outside-base';
  if (
    hasNodeErrorCode(error, 'ENOENT')
    || hasNodeErrorCode(error, 'ENOTDIR')
    || hasNodeErrorCode(error, 'ELOOP')
  ) return 'not-found';
  if (hasNodeErrorCode(error, 'EACCES') || hasNodeErrorCode(error, 'EPERM')) {
    return 'permission-denied';
  }
  return null;
}
