import type { Database } from 'bun:sqlite';
import type { IssueMutationPayload } from '../../common/issue-commands.js';
import { ISSUE_FIELDS } from '../../common/issue-records.js';
import { formatIssueId } from '../../common/issue-validation.js';
import { issueOwnerKey, type Issue, type IssueComment, type IssueFieldChange } from '../../common/issues.js';
import { issueAuthorityKey, type IssueMutationContext } from './contracts.js';
import { IssueDomainError, nextIssueCounter } from './errors.js';
import { appendActivity, decodeComment, insertComment, nextAutoincrement, requireComment,
  requireIssue, requireIssueRevision, saveIssue, updateComment } from './records.js';
import { requireLinkCapacity, requireNoBlockingCycle, validateIssueParent } from './relationships.js';

export interface IssueMutationCommit {
  readonly issue: Issue;
  readonly comment?: IssueComment;
  readonly relatedIssue?: Issue;
  readonly changed: boolean;
}

function fieldChanges(current: Issue, next: Issue): IssueFieldChange[] {
  const changes: IssueFieldChange[] = [];
  for (const field of ISSUE_FIELDS) {
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
      changes.push({ field, before: current[field], after: next[field] } as IssueFieldChange);
    }
  }
  return changes;
}

function commitFields(database: Database, current: Issue, candidate: Issue,
  action: 'updated' | 'claimed' | 'released' | 'closed' | 'reopened',
  context: IssueMutationContext, now: string): IssueMutationCommit {
  const changes = fieldChanges(current, candidate);
  if (!changes.length) return { issue: current, changed: false };
  const issue = { ...candidate, revision: nextIssueCounter(current.revision), updatedAt: now };
  if (issue.parentId !== current.parentId && issue.parentId) requireIssue(database, issue.parentId);
  saveIssue(database, issue);
  if (issue.parentId !== current.parentId) validateIssueParent(database, issue);
  appendActivity(database, issue.id, { action, changes }, context, now);
  return { issue, changed: true };
}

function create(database: Database, payload: Extract<IssueMutationPayload, { action: 'create' }>,
  context: IssueMutationContext, now: string): IssueMutationCommit {
  const input = payload.input;
  if (input.parentId) requireIssue(database, input.parentId);
  const number = nextAutoincrement(database, 'issues');
  const issue: Issue = { id: formatIssueId(number), number, revision: 1, title: input.title,
    description: input.description ?? '', project: input.project, status: 'open', resolution: null,
    priority: input.priority ?? 2, labels: input.labels ?? [], assignee: input.assignee ?? null,
    parentId: input.parentId ?? null, createdAt: now, updatedAt: now, createdBy: context.actor };
  database.query(`INSERT INTO issues
    (number, revision, project, status, resolution, priority, payload_json) VALUES (?,1,?,'open',NULL,?,?)`)
    .run(number, issue.project, issue.priority, JSON.stringify(issue));
  saveIssue(database, issue);
  validateIssueParent(database, issue);
  appendActivity(database, issue.id, { action: 'created', issue }, context, now);
  return { issue, changed: true };
}

function addComment(database: Database, issue: Issue, body: string,
  context: IssueMutationContext, now: string): IssueComment {
  const latest = database.query<{ sequence: number | null }, [number]>(
    'SELECT max(sequence) AS sequence FROM issue_comments WHERE issue_number=?',
  ).get(issue.number)?.sequence ?? 0;
  const comment: IssueComment = { id: crypto.randomUUID(), issueId: issue.id,
    sequence: nextIssueCounter(latest), revision: 1, body, author: context.actor,
    createdAt: now, updatedAt: now, deletedAt: null };
  insertComment(database, comment, issueAuthorityKey(context.authority));
  appendActivity(database, issue.id, { action: 'comment-added', commentId: comment.id, before: null, after: body }, context, now);
  return comment;
}

function changeComment(database: Database, issue: Issue,
  payload: Extract<IssueMutationPayload, { action: 'comment-edit' | 'comment-delete' }>,
  context: IssueMutationContext, now: string): IssueMutationCommit {
  const stored = requireComment(database, payload.commentId, issue.id);
  if (stored.authority_key !== issueAuthorityKey(context.authority)) {
    throw new IssueDomainError('ISSUE_FORBIDDEN', 'Only the comment author can change it.');
  }
  const current = decodeComment(stored);
  if (current.revision !== payload.expectedRevision) {
    throw new IssueDomainError('ISSUE_COMMENT_REVISION_CONFLICT', 'Comment changed. Read it before retrying.', undefined, current);
  }
  if (payload.action === 'comment-edit' && current.deletedAt !== null) {
    throw new IssueDomainError('ISSUE_INVALID_TRANSITION', 'Removed comments cannot be edited.');
  }
  if ((payload.action === 'comment-delete' && current.deletedAt !== null)
    || (payload.action === 'comment-edit' && current.body === payload.body)) {
    return { issue, comment: current, changed: false };
  }
  const deleting = payload.action === 'comment-delete';
  const body = payload.action === 'comment-edit' ? payload.body : null;
  const comment = { ...current, body, revision: nextIssueCounter(current.revision), updatedAt: now,
    deletedAt: deleting ? now : null };
  updateComment(database, comment);
  appendActivity(database, issue.id, { action: deleting ? 'comment-removed' : 'comment-edited',
    commentId: comment.id, before: current.body, after: body }, context, now);
  return { issue, comment, changed: true };
}

function changeLink(database: Database, issue: Issue,
  payload: Extract<IssueMutationPayload, { action: 'link' | 'unlink' }>,
  context: IssueMutationContext, now: string): IssueMutationCommit {
  const target = requireIssue(database, payload.targetId);
  requireIssueRevision(target, payload.targetRevision);
  if (issue.id === target.id) throw new IssueDomainError('ISSUE_RELATIONSHIP_CYCLE', 'An issue cannot link to itself.');
  let sourceNumber = issue.number;
  let targetNumber = target.number;
  if (payload.kind === 'related' && sourceNumber > targetNumber) [sourceNumber, targetNumber] = [targetNumber, sourceNumber];
  const existing = database.query('SELECT 1 FROM issue_links WHERE source_number=? AND target_number=? AND kind=?')
    .get(sourceNumber, targetNumber, payload.kind);
  if ((payload.action === 'link') === Boolean(existing)) return { issue, relatedIssue: target, changed: false };
  if (payload.action === 'link') {
    requireLinkCapacity(database, sourceNumber, targetNumber);
    if (payload.kind === 'blocks') requireNoBlockingCycle(database, issue.id, target.id);
    database.query('INSERT INTO issue_links VALUES (?,?,?)').run(sourceNumber, targetNumber, payload.kind);
  } else {
    database.query('DELETE FROM issue_links WHERE source_number=? AND target_number=? AND kind=?')
      .run(sourceNumber, targetNumber, payload.kind);
  }
  const next = { ...issue, revision: nextIssueCounter(issue.revision), updatedAt: now };
  const relatedIssue = { ...target, revision: nextIssueCounter(target.revision), updatedAt: now };
  for (const endpoint of [next, relatedIssue]) {
    saveIssue(database, endpoint);
    appendActivity(database, endpoint.id, { action: payload.action === 'link' ? 'linked' : 'unlinked',
      kind: payload.kind, sourceId: formatIssueId(sourceNumber), targetId: formatIssueId(targetNumber) }, context, now);
  }
  return { issue: next, relatedIssue, changed: true };
}

export function mutateIssue(database: Database, payload: IssueMutationPayload,
  context: IssueMutationContext, now: string): IssueMutationCommit {
  if (payload.action === 'create') return create(database, payload, context, now);
  const current = requireIssue(database, payload.issueId);
  if (payload.action === 'comment') {
    return { issue: current, comment: addComment(database, current, payload.body, context, now), changed: true };
  }
  if (payload.action === 'comment-edit' || payload.action === 'comment-delete') {
    return changeComment(database, current, payload, context, now);
  }
  requireIssueRevision(current, payload.expectedRevision);
  switch (payload.action) {
    case 'update':
      if (payload.patch.status !== undefined && current.status === 'closed') {
        throw new IssueDomainError('ISSUE_INVALID_TRANSITION', 'Use reopen before changing a closed issue status.');
      }
      return commitFields(database, current, { ...current, ...payload.patch }, 'updated', context, now);
    case 'claim':
      if (current.status === 'closed') throw new IssueDomainError('ISSUE_INVALID_TRANSITION', 'A closed issue cannot be claimed.');
      if (current.assignee && issueOwnerKey(current.assignee) !== issueOwnerKey(context.owner)) {
        throw new IssueDomainError('ISSUE_ALREADY_CLAIMED', 'Issue is assigned to another owner.', current);
      }
      return commitFields(database, current, { ...current, assignee: context.owner,
        status: current.status === 'open' ? 'in-progress' : current.status }, 'claimed', context, now);
    case 'release':
      if (current.assignee && issueOwnerKey(current.assignee) !== issueOwnerKey(context.owner)) {
        throw new IssueDomainError('ISSUE_ALREADY_CLAIMED', 'Only the assigned owner can release this issue.', current);
      }
      return commitFields(database, current, { ...current, assignee: null }, 'released', context, now);
    case 'reopen':
      if (current.status !== 'closed') return { issue: current, changed: false };
      return commitFields(database, current, { ...current, status: 'open', resolution: null }, 'reopened', context, now);
    case 'close': {
      const resolution = payload.resolution ?? 'done';
      if (current.status === 'closed' && current.resolution !== resolution) {
        throw new IssueDomainError('ISSUE_INVALID_TRANSITION', 'Reopen the issue before changing its resolution.');
      }
      const commit = commitFields(database, current, { ...current, status: 'closed', resolution }, 'closed', context, now);
      if (payload.comment === undefined) return commit;
      return { ...commit, changed: true, comment: addComment(database, commit.issue, payload.comment, context, now) };
    }
    case 'link': case 'unlink': return changeLink(database, current, payload, context, now);
  }
}
