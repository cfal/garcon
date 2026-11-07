import type { GhPublishedPullRequest, GhResults } from '../../../common/gh.js';
import type { GitExecutorScope } from '../../../common/git-execution.js';
import type { WorkflowApprovalManifest, WorkflowManagedTarget, WorkflowTaskSpec } from '../../../common/workflows.js';

export type WorkflowPublicationSpec = Extract<WorkflowTaskSpec, { kind: 'publish-pr' }>;
export type WorkflowPublication = NonNullable<WorkflowApprovalManifest['publication']>;
export type WorkflowPublicationEffect<T> = { readonly kind: 'observed'; readonly value: T }
  | { readonly kind: 'not-started' | 'unknown'; readonly detail: string };

export interface WorkflowPublicationCall {
  verify(signal: AbortSignal): Promise<void>;
  push(): Promise<WorkflowPublicationEffect<void>>;
  create(): Promise<WorkflowPublicationEffect<GhPublishedPullRequest>>;
}

export interface WorkflowPublicationPort {
  inspectTarget(spec: WorkflowPublicationSpec, signal: AbortSignal): Promise<GitExecutorScope & GhResults['getPublicationTarget']>;
  prepare(publication: WorkflowPublication, resource: WorkflowManagedTarget, signal: AbortSignal): Promise<WorkflowPublicationCall>;
  find(publication: WorkflowPublication, signal: AbortSignal): Promise<GitExecutorScope & GhResults['findPullRequests']>;
}
