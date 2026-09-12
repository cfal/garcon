import type { Issue, IssueLinkKind, IssueOwner, IssuePriority, IssueResolution, IssueStatus,
  IssueListQuery, IssueReadQuery, IssueHistoryQuery } from './issues.js';
import { issueBody, issueChatId, issueCommentBody, issueId, issueInteger, issueInvalid,
  issueLabels, issueLinkKind, issueOwner, issuePriority, issueProject, issueRecord,
  issueResolution, issueStatus, issueTitle, issueUuid } from './issue-validation.js';

export interface IssueCreateFields {
  readonly title: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  readonly labels?: readonly string[];
  readonly assignee?: IssueOwner | null;
  readonly parentId?: string | null;
}

export type IssuePatch = Partial<Pick<Issue,
  'title' | 'description' | 'project' | 'priority' | 'labels' | 'assignee' | 'parentId'>>
  & { readonly status?: Exclude<IssueStatus, 'closed'> };

export interface UpdateIssuePayload {
  readonly action: 'update';
  readonly issueId: string;
  readonly expectedRevision: number;
  readonly patch: IssuePatch;
}

export type IssueMutationPayload =
  | { readonly action: 'create'; readonly input: IssueCreateFields & { readonly project: string } }
  | UpdateIssuePayload
  | { readonly action: 'claim' | 'release' | 'reopen'; readonly issueId: string; readonly expectedRevision: number }
  | { readonly action: 'close'; readonly issueId: string; readonly expectedRevision: number;
      readonly resolution?: IssueResolution; readonly comment?: string }
  | { readonly action: 'comment'; readonly issueId: string; readonly body: string }
  | { readonly action: 'comment-edit'; readonly issueId: string; readonly commentId: string;
      readonly expectedRevision: number; readonly body: string }
  | { readonly action: 'comment-delete'; readonly issueId: string; readonly commentId: string;
      readonly expectedRevision: number }
  | { readonly action: 'link' | 'unlink'; readonly issueId: string; readonly expectedRevision: number;
      readonly targetId: string; readonly targetRevision: number; readonly kind: IssueLinkKind };

export type MarkupIssueMutationPayload =
  | Exclude<IssueMutationPayload, { readonly action: 'create' }>
  | { readonly action: 'create'; readonly input: IssueCreateFields & { readonly project?: string } };

export interface HttpIssueMutationRequest {
  readonly requestId: string;
  readonly expectedStoreId: string;
  readonly fromChatId?: string;
  readonly payload: IssueMutationPayload;
}

export type IssueReadPayload =
  | { readonly action: 'list'; readonly query: IssueListQuery }
  | { readonly action: 'read'; readonly query: IssueReadQuery }
  | { readonly action: 'history'; readonly query: IssueHistoryQuery };

export type IssueAction = IssueMutationPayload['action'] | IssueReadPayload['action'];
export const ISSUE_ACTIONS = ['create', 'update', 'claim', 'release', 'reopen', 'close',
  'comment', 'comment-edit', 'comment-delete', 'link', 'unlink', 'list', 'read', 'history'] as const;

const createKeys = ['title', 'description', 'project', 'priority', 'labels', 'assignee', 'parentId'];
const patchKeys = [...createKeys, 'status'];

export function parseIssuePatch(value: unknown): IssuePatch {
  const raw = issueRecord(value, patchKeys);
  if (Object.keys(raw).length === 0) return issueInvalid('An issue patch must not be empty.');
  const patch: IssuePatch = {
    ...(raw.title !== undefined ? { title: issueTitle(raw.title) } : {}),
    ...(raw.description !== undefined ? { description: issueBody(raw.description) } : {}),
    ...(raw.project !== undefined ? { project: issueProject(raw.project) } : {}),
    ...(raw.priority !== undefined ? { priority: issuePriority(raw.priority) } : {}),
    ...(raw.labels !== undefined ? { labels: issueLabels(raw.labels) } : {}),
    ...(raw.assignee !== undefined ? { assignee: nullableOwner(raw.assignee) } : {}),
    ...(raw.parentId !== undefined ? { parentId: nullableIssueId(raw.parentId) } : {}),
  };
  if (raw.status === undefined) {
    if (!Object.keys(patch).length) return issueInvalid('An issue patch must not be empty.');
    return patch;
  }
  const status = issueStatus(raw.status);
  if (status === 'closed') return issueInvalid('Use close to close an issue.');
  return { ...patch, status };
}

function nullableOwner(value: unknown): IssueOwner | null {
  return value === null ? null : issueOwner(value);
}

function nullableIssueId(value: unknown): string | null {
  return value === null ? null : issueId(value);
}

export function parseMarkupIssueMutationPayload(value: unknown): MarkupIssueMutationPayload {
  const raw = issueRecord(value, ['action', 'input', 'issueId', 'expectedRevision', 'patch',
    'resolution', 'comment', 'body', 'commentId', 'targetId', 'targetRevision', 'kind']);
  if (raw.action === 'create') {
    issueRecord(raw, ['action', 'input']);
    const input = issueRecord(raw.input, createKeys);
    return { action: 'create', input: {
      title: issueTitle(input.title),
      description: input.description === undefined ? '' : issueBody(input.description),
      priority: input.priority === undefined ? 2 : issuePriority(input.priority),
      labels: input.labels === undefined ? [] : issueLabels(input.labels),
      assignee: input.assignee === undefined ? null : nullableOwner(input.assignee),
      parentId: input.parentId === undefined ? null : nullableIssueId(input.parentId),
      ...(input.project !== undefined ? { project: issueProject(input.project) } : {}),
    } };
  }
  const target = issueId(raw.issueId);
  if (raw.action === 'comment') {
    issueRecord(raw, ['action', 'issueId', 'body']);
    return { action: 'comment', issueId: target, body: issueCommentBody(raw.body) };
  }
  const expectedRevision = issueInteger(raw.expectedRevision, 'expectedRevision');
  const base = { issueId: target, expectedRevision };
  switch (raw.action) {
    case 'update':
      issueRecord(raw, ['action', 'issueId', 'expectedRevision', 'patch']);
      return { action: 'update', ...base, patch: parseIssuePatch(raw.patch) };
    case 'claim':
    case 'release':
    case 'reopen':
      issueRecord(raw, ['action', 'issueId', 'expectedRevision']);
      return { action: raw.action, ...base };
    case 'close':
      issueRecord(raw, ['action', 'issueId', 'expectedRevision', 'resolution', 'comment']);
      return { action: 'close', ...base,
        resolution: raw.resolution === undefined ? 'done' : issueResolution(raw.resolution),
        ...(raw.comment !== undefined ? { comment: issueCommentBody(raw.comment) } : {}) };
    case 'comment-edit':
      issueRecord(raw, ['action', 'issueId', 'expectedRevision', 'commentId', 'body']);
      return { action: 'comment-edit', ...base, commentId: issueUuid(raw.commentId, 'commentId'),
        body: issueCommentBody(raw.body) };
    case 'comment-delete':
      issueRecord(raw, ['action', 'issueId', 'expectedRevision', 'commentId']);
      return { action: 'comment-delete', ...base, commentId: issueUuid(raw.commentId, 'commentId') };
    case 'link':
    case 'unlink':
      issueRecord(raw, ['action', 'issueId', 'expectedRevision', 'targetId', 'targetRevision', 'kind']);
      return { action: raw.action, ...base, targetId: issueId(raw.targetId),
        targetRevision: issueInteger(raw.targetRevision, 'targetRevision'), kind: issueLinkKind(raw.kind) };
    default:
      return issueInvalid('Unknown issue mutation.');
  }
}

export function parseIssueMutationPayload(value: unknown): IssueMutationPayload {
  const payload = parseMarkupIssueMutationPayload(value);
  if (payload.action !== 'create') return payload;
  return { action: 'create', input: { ...payload.input, project: issueProject(payload.input.project) } };
}

export function parseHttpIssueMutationRequest(value: unknown): HttpIssueMutationRequest {
  const raw = issueRecord(value, ['requestId', 'expectedStoreId', 'fromChatId', 'payload']);
  return {
    requestId: issueUuid(raw.requestId, 'requestId'),
    expectedStoreId: issueUuid(raw.expectedStoreId, 'expectedStoreId'),
    ...(raw.fromChatId !== undefined ? { fromChatId: issueChatId(raw.fromChatId) } : {}),
    payload: parseIssueMutationPayload(raw.payload),
  };
}
