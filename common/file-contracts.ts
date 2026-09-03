import { isRecord } from './json.js';

export interface CanonicalFileIdentity {
  canonicalFileRootPath: string;
  normalizedRelativePath: string;
}

export interface FileIdentityResponse {
  success: true;
  identity: CanonicalFileIdentity;
}

export type FileRevision = string;

export const FILE_REVISION_HEADER = 'X-Garcon-File-Revision';
export const MAX_FILE_VIEW_BYTES = 25 * 1024 * 1024;

export type FileRevisionResponse =
  | { status: 'ready'; revision: FileRevision }
  | { status: 'missing' };

export interface ReadTextResponse {
  content: string;
  path: string;
  revision: FileRevision;
}

export type FileSaveConflictResolution = 'reject' | 'overwrite';

export interface SaveTextRequest {
  content: string;
  expectedRevision: FileRevision;
  conflictResolution: FileSaveConflictResolution;
}

export interface SaveTextResponse {
  success: true;
  path: string;
  message: string;
  revision: FileRevision;
}

export type FileTreeEntryType = 'file' | 'directory';

export interface FileTreeEntry {
  name: string;
  path: string;
  relativePath: string;
  type: FileTreeEntryType;
  size: number;
  modified: string | null;
  permissionsRwx: string;
}

export interface FileTreeBreadcrumb {
  name: string;
  path: string;
}

export interface FileTreeDirectory {
  path: string;
  relativePath: string;
  parentPath: string | null;
  breadcrumbs: FileTreeBreadcrumb[];
}

export interface FileTreeHomeDirectory {
  path: string;
  breadcrumbs: FileTreeBreadcrumb[];
}

export interface FileTreeResponse {
  fileRootPath: string;
  homeDirectory: FileTreeHomeDirectory | null;
  directory: FileTreeDirectory;
  entries: FileTreeEntry[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isFileRevision(value: unknown): value is FileRevision {
  return (
    typeof value === 'string' && /^v1:[A-Za-z0-9_-]+$/.test(value)
  );
}

export function parseFileRevisionResponse(
  value: unknown,
): FileRevisionResponse | null {
  if (!isRecord(value)) return null;
  if (value.status === 'missing') return { status: 'missing' };
  if (value.status !== 'ready' || !isFileRevision(value.revision)) return null;
  return { status: 'ready', revision: value.revision };
}

export function parseReadTextResponse(value: unknown): ReadTextResponse | null {
  if (
    !isRecord(value) ||
    typeof value.content !== 'string' ||
    !isNonEmptyString(value.path) ||
    !isFileRevision(value.revision)
  ) {
    return null;
  }
  return {
    content: value.content,
    path: value.path,
    revision: value.revision,
  };
}

export function parseSaveTextRequest(value: unknown): SaveTextRequest | null {
  if (
    !isRecord(value) ||
    typeof value.content !== 'string' ||
    !isFileRevision(value.expectedRevision) ||
    (value.conflictResolution !== 'reject' &&
      value.conflictResolution !== 'overwrite')
  ) {
    return null;
  }
  return {
    content: value.content,
    expectedRevision: value.expectedRevision,
    conflictResolution: value.conflictResolution,
  };
}

export function parseSaveTextResponse(value: unknown): SaveTextResponse | null {
  if (
    !isRecord(value) ||
    value.success !== true ||
    !isNonEmptyString(value.path) ||
    !isNonEmptyString(value.message) ||
    !isFileRevision(value.revision)
  ) {
    return null;
  }
  return {
    success: true,
    path: value.path,
    message: value.message,
    revision: value.revision,
  };
}

function parseFileTreeBreadcrumb(value: unknown): FileTreeBreadcrumb | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.name) || !isNonEmptyString(value.path))
    return null;
  return { name: value.name, path: value.path };
}

function parseFileTreeBreadcrumbs(
  value: unknown,
): FileTreeBreadcrumb[] | null {
  if (!Array.isArray(value)) return null;
  const breadcrumbs = value.map(parseFileTreeBreadcrumb);
  if (
    breadcrumbs.length === 0 ||
    breadcrumbs.some((breadcrumb) => breadcrumb === null)
  ) {
    return null;
  }
  return breadcrumbs as FileTreeBreadcrumb[];
}

function parseFileTreeDirectory(value: unknown): FileTreeDirectory | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.path) ||
    typeof value.relativePath !== 'string' ||
    (value.parentPath !== null && !isNonEmptyString(value.parentPath))
  ) {
    return null;
  }
  const breadcrumbs = parseFileTreeBreadcrumbs(value.breadcrumbs);
  if (!breadcrumbs) return null;
  return {
    path: value.path,
    relativePath: value.relativePath,
    parentPath: value.parentPath,
    breadcrumbs,
  };
}

function parseFileTreeHomeDirectory(
  value: unknown,
): FileTreeHomeDirectory | null {
  if (!isRecord(value) || !isNonEmptyString(value.path)) return null;
  const breadcrumbs = parseFileTreeBreadcrumbs(value.breadcrumbs);
  if (!breadcrumbs) return null;
  return { path: value.path, breadcrumbs };
}

function parseFileTreeEntry(value: unknown): FileTreeEntry | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.path) ||
    !isNonEmptyString(value.relativePath) ||
    (value.type !== 'file' && value.type !== 'directory') ||
    typeof value.size !== 'number' ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    (value.modified !== null && typeof value.modified !== 'string') ||
    (typeof value.modified === 'string' &&
      Number.isNaN(Date.parse(value.modified))) ||
    !isNonEmptyString(value.permissionsRwx)
  ) {
    return null;
  }
  return {
    name: value.name,
    path: value.path,
    relativePath: value.relativePath,
    type: value.type,
    size: value.size,
    modified: value.modified,
    permissionsRwx: value.permissionsRwx,
  };
}

export function parseFileTreeResponse(value: unknown): FileTreeResponse | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.fileRootPath) || !Array.isArray(value.entries))
    return null;
  const homeDirectory =
    value.homeDirectory === null
      ? null
      : parseFileTreeHomeDirectory(value.homeDirectory);
  const directory = parseFileTreeDirectory(value.directory);
  const entries = value.entries.map(parseFileTreeEntry);
  if (
    (value.homeDirectory !== null && !homeDirectory) ||
    !directory ||
    entries.some((entry) => entry === null)
  ) {
    return null;
  }
  const isBaseDirectory = directory.path === value.fileRootPath;
  if (
    isBaseDirectory !== (directory.relativePath === '') ||
    isBaseDirectory !== (directory.parentPath === null) ||
    directory.breadcrumbs[0]?.path !== value.fileRootPath ||
    directory.breadcrumbs.at(-1)?.path !== directory.path ||
    (homeDirectory !== null &&
      (homeDirectory.breadcrumbs[0]?.path !== value.fileRootPath ||
        homeDirectory.breadcrumbs.at(-1)?.path !== homeDirectory.path))
  ) {
    return null;
  }
  return {
    fileRootPath: value.fileRootPath,
    homeDirectory,
    directory,
    entries: entries as FileTreeEntry[],
  };
}

export function parseFileIdentityResponse(
  value: unknown,
): FileIdentityResponse | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const identity = record.identity;
  if (record.success !== true || !identity || typeof identity !== 'object')
    return null;
  const fields = identity as Record<string, unknown>;
  if (
    typeof fields.canonicalFileRootPath !== 'string' ||
    !fields.canonicalFileRootPath ||
    typeof fields.normalizedRelativePath !== 'string' ||
    !fields.normalizedRelativePath
  )
    return null;
  return {
    success: true,
    identity: {
      canonicalFileRootPath: fields.canonicalFileRootPath,
      normalizedRelativePath: fields.normalizedRelativePath,
    },
  };
}
