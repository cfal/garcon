import { isGitPatchBody } from '../../../../common/git-result-validation.js';
import { isRecord } from '../../../../common/json.js';

const CATEGORIES = ['normal', 'generated', 'lockfile', 'binary', 'large'];
const BODY_STATES = ['unloaded', 'loading', 'loaded', 'binary', 'too-large', 'error'];
const STATUSES = ['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'unknown'];
const LIMIT_REASONS = [
  'collection-too-many-files', 'collection-too-many-rows', 'collection-too-many-bytes', 'file-too-many-rows',
  'file-too-many-bytes', 'line-too-long', 'binary', 'unsupported-file-kind', 'git-timeout',
];

const member = (choices: string[], value: unknown) => typeof value === 'string' && choices.includes(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const text = (value: unknown) => typeof value === 'string';
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

export function recordWidth(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function limitReason(value: unknown): boolean {
  return member(LIMIT_REASONS, value);
}

function patchBody(value: unknown): boolean {
  return isRecord(value) && isGitPatchBody(value)
    && optional(value.limitReason, limitReason) && optional(value.limitMessage, text);
}

export function patchBodies(value: unknown): boolean {
  return Array.isArray(value) && value.every(patchBody);
}

export function onePatchBody(value: unknown): boolean {
  return patchBody(value);
}

function fileSummary(value: Record<string, unknown>): boolean {
  return text(value.path) && optional(value.originalPath, text)
    && member(CATEGORIES, value.category) && member(BODY_STATES, value.bodyState)
    && numeric(value.additions) && numeric(value.deletions) && numeric(value.estimatedRows)
    && text(value.bodyFingerprint) && typeof value.isBinary === 'boolean' && typeof value.isTooLarge === 'boolean'
    && optional(value.limitReason, limitReason) && optional(value.limitMessage, text);
}

function workbenchStatus(value: Record<string, unknown>): boolean {
  return text(value.indexStatus) && text(value.workTreeStatus);
}

function treeStatus(value: Record<string, unknown>): boolean {
  return member(STATUSES, value.status) && text(value.rawStatus);
}

export function workbenchFile(value: unknown): boolean {
  return isRecord(value) && fileSummary(value) && workbenchStatus(value);
}

export function treeDiffFile(value: unknown): boolean {
  return isRecord(value) && fileSummary(value) && treeStatus(value);
}

export function registeredFiles(value: unknown): boolean {
  return Array.isArray(value) && value.every((file) =>
    isRecord(file) && fileSummary(file) && isRecord(file.change)
    && (file.change.kind === 'workbench' && workbenchStatus(file.change)
      || file.change.kind === 'tree-diff' && treeStatus(file.change)));
}

export function pathTokens(value: unknown): boolean {
  if (!(value instanceof Map)) return false;
  for (const [path, token] of value) {
    if (!text(path) || !isRecord(token) || !text(token.path) || !text(token.status)
      || !member(['missing', 'file', 'symlink', 'directory', 'other'], token.worktreeKind)
      || ![token.indexEntry, token.worktreeSize, token.worktreeMtimeNs, token.worktreeCtimeNs].every((field) => field === null || text(field))) {
      return false;
    }
  }
  return true;
}
