import { promises as fs } from 'fs';
import path from 'path';
import { getProjectBasePath } from '../config.js';
import { jsonError } from './http-error.js';

export const PROJECT_BOUNDARY_ERROR_CODE = 'outside_project_base';
export const PROJECT_BOUNDARY_ERROR_MESSAGE = 'Path is outside the allowed base directory';

export class ProjectBoundaryError extends Error {
  readonly errorCode = PROJECT_BOUNDARY_ERROR_CODE;
  readonly status = 403;

  constructor(message = PROJECT_BOUNDARY_ERROR_MESSAGE) {
    super(message);
    this.name = 'ProjectBoundaryError';
  }
}

function normalizedProjectBase(): string {
  return path.resolve(getProjectBasePath());
}

function isWithinResolvedRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR'),
  );
}

async function realpathClosestExistingAncestor(targetPath: string): Promise<{
  realAncestor: string;
  missingSegments: string[];
}> {
  const missingSegments: string[] = [];
  let candidate = path.resolve(targetPath);

  while (true) {
    try {
      return {
        realAncestor: await fs.realpath(candidate),
        missingSegments: missingSegments.reverse(),
      };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function resolveRealPathAllowMissing(targetPath: string): Promise<string> {
  const { realAncestor, missingSegments } = await realpathClosestExistingAncestor(targetPath);
  return path.resolve(realAncestor, ...missingSegments);
}

export function isWithinProjectBase(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const projectBasePath = normalizedProjectBase();
  const projectBasePathPrefix = projectBasePath.endsWith(path.sep)
    ? projectBasePath
    : `${projectBasePath}${path.sep}`;
  return resolved === projectBasePath || resolved.startsWith(projectBasePathPrefix);
}

export async function resolveRealWithinBase(rootPath: string, inputPath: string): Promise<string> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedInput = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(resolvedRoot, inputPath);

  if (!isWithinResolvedRoot(resolvedRoot, resolvedInput)) {
    throw new ProjectBoundaryError();
  }

  const realRoot = await resolveRealPathAllowMissing(resolvedRoot);
  const { realAncestor, missingSegments } = await realpathClosestExistingAncestor(resolvedInput);
  const realTarget = path.resolve(realAncestor, ...missingSegments);
  if (!isWithinResolvedRoot(realRoot, realTarget)) {
    throw new ProjectBoundaryError();
  }
  return realTarget;
}

export async function assertRealWithinProjectBase(targetPath: string): Promise<string> {
  return resolveRealWithinBase(normalizedProjectBase(), targetPath);
}

export function assertWithinProjectBase(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!isWithinProjectBase(resolved)) {
    throw new ProjectBoundaryError();
  }
  return resolved;
}

export function isProjectBoundaryError(error: unknown): error is ProjectBoundaryError {
  return error instanceof ProjectBoundaryError;
}

export function projectBoundaryErrorResponse(): Response {
  return jsonError(PROJECT_BOUNDARY_ERROR_MESSAGE, 403, PROJECT_BOUNDARY_ERROR_CODE);
}
