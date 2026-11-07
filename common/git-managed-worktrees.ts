import { isRecord } from './json.js';

export interface CreateManagedWorktreeRequest {
  readonly projectPath: string;
  readonly worktreePath: string;
  readonly operationId: string;
  readonly managedResourceId: string;
  readonly branch: string;
  readonly baseCommit: string;
}

export interface InspectManagedWorktreeRequest {
  readonly projectPath: string;
  readonly worktreePath: string;
  readonly operationId: string;
  readonly managedResourceId: string;
}

export interface RemoveManagedWorktreeRequest extends InspectManagedWorktreeRequest {
  readonly expectedRepositoryIdentity: string;
  readonly expectedWorktreeIdentity: string;
  readonly expectedHead: string;
  readonly expectedBranch: string;
}

export interface ManagedWorktreeSnapshot {
  readonly operationId: string;
  readonly managedResourceId: string;
  readonly repositoryIdentity: string;
  readonly worktreeIdentity: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly head: string;
  readonly dirty: boolean;
}

export const isManagedResourceId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const isGitObjectId = (value: unknown): value is string => typeof value === 'string'
  && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export function isManagedWorktreeSnapshot(value: unknown): value is ManagedWorktreeSnapshot {
  const text = (input: unknown): input is string => typeof input === 'string' && input.length > 0
    && input.length <= 4096 && !input.includes('\0');
  return isRecord(value) && isManagedResourceId(value.operationId) && isManagedResourceId(value.managedResourceId)
    && text(value.repositoryIdentity) && text(value.worktreeIdentity) && text(value.worktreePath) && text(value.branch)
    && isGitObjectId(value.baseCommit) && isGitObjectId(value.head) && typeof value.dirty === 'boolean'
    && Object.keys(value).every(key => ['operationId', 'managedResourceId', 'repositoryIdentity', 'worktreeIdentity',
      'worktreePath', 'branch', 'baseCommit', 'head', 'dirty'].includes(key));
}
