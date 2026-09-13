import type { Issue, IssueActivity, IssueComment, IssueField, IssueFieldChange, IssueWriteResult } from './issues.js';
import { formatIssueId, issueActor, issueBody, issueCommentBody, storedIssueId, issueInteger, issueInvalid, issueLabels,
  issueLinkKind, issueOwner, issuePriority, issueProject, issueRecord, issueResolution, issueSource,
  issueStatus, issueTimestamp, issueTitle, issueUuid } from './issue-validation.js';

const issueKeys = ['id', 'number', 'revision', 'title', 'description', 'project', 'status', 'resolution',
  'priority', 'labels', 'assignee', 'parentId', 'createdAt', 'updatedAt', 'createdBy'];
const commentKeys = ['id', 'issueId', 'sequence', 'revision', 'body', 'author', 'createdAt', 'updatedAt', 'deletedAt'];
export const ISSUE_FIELDS: readonly IssueField[] = ['title', 'description', 'project', 'status', 'resolution',
  'priority', 'labels', 'assignee', 'parentId'];

export function parseIssue(value: unknown): Issue {
  const raw = issueRecord(value, issueKeys);
  const id = storedIssueId(raw.id);
  const number = issueInteger(raw.number, 'number');
  if (id !== formatIssueId(number)) return issueInvalid('Issue ID and number disagree.');
  const status = issueStatus(raw.status);
  const resolution = raw.resolution === null ? null : issueResolution(raw.resolution);
  if ((status === 'closed') !== (resolution !== null)) return issueInvalid('Issue status and resolution disagree.');
  return { id, number, revision: issueInteger(raw.revision, 'revision'),
    title: issueTitle(raw.title), description: issueBody(raw.description), project: issueProject(raw.project),
    status, resolution, priority: issuePriority(raw.priority), labels: issueLabels(raw.labels),
    assignee: raw.assignee === null ? null : issueOwner(raw.assignee),
    parentId: raw.parentId === null ? null : storedIssueId(raw.parentId),
    createdAt: issueTimestamp(raw.createdAt), updatedAt: issueTimestamp(raw.updatedAt), createdBy: issueActor(raw.createdBy) };
}

export function parseIssueComment(value: unknown): IssueComment {
  const raw = issueRecord(value, commentKeys);
  const deletedAt = raw.deletedAt === null ? null : issueTimestamp(raw.deletedAt);
  const body = raw.body === null ? null : issueCommentBody(raw.body);
  if ((deletedAt === null) !== (body !== null)) return issueInvalid('Comment body and tombstone disagree.');
  return { id: issueUuid(raw.id, 'commentId'), issueId: storedIssueId(raw.issueId),
    sequence: issueInteger(raw.sequence, 'sequence'), revision: issueInteger(raw.revision, 'revision'),
    body, deletedAt, author: issueActor(raw.author),
    createdAt: issueTimestamp(raw.createdAt), updatedAt: issueTimestamp(raw.updatedAt) };
}

function fieldValue<K extends IssueField>(field: K, value: unknown): Issue[K] {
  let parsed: Issue[IssueField];
  switch (field) {
    case 'title': parsed = issueTitle(value); break;
    case 'description': parsed = issueBody(value); break;
    case 'project': parsed = issueProject(value); break;
    case 'status': parsed = issueStatus(value); break;
    case 'resolution': parsed = value === null ? null : issueResolution(value); break;
    case 'priority': parsed = issuePriority(value); break;
    case 'labels': parsed = issueLabels(value); break;
    case 'assignee': parsed = value === null ? null : issueOwner(value); break;
    case 'parentId': parsed = value === null ? null : storedIssueId(value); break;
    default: return issueInvalid('Invalid activity field.');
  }
  return parsed as Issue[K];
}

function parseChange(value: unknown): IssueFieldChange {
  const raw = issueRecord(value, ['field', 'before', 'after']);
  if (!ISSUE_FIELDS.includes(raw.field as IssueField)) return issueInvalid('Invalid activity field.');
  const field = raw.field as IssueField;
  return { field, before: fieldValue(field, raw.before), after: fieldValue(field, raw.after) } as IssueFieldChange;
}

export function parseIssueActivity(value: unknown): IssueActivity {
  const baseKeys = ['sequence', 'issueId', 'at', 'actor', 'source', 'action'];
  const raw = issueRecord(value, [...baseKeys, 'issue', 'changes', 'commentId', 'before', 'after', 'kind', 'sourceId', 'targetId']);
  const base = { sequence: issueInteger(raw.sequence, 'sequence'), issueId: storedIssueId(raw.issueId),
    at: issueTimestamp(raw.at), actor: issueActor(raw.actor), source: raw.source === null ? null : issueSource(raw.source) };
  switch (raw.action) {
    case 'created': {
      issueRecord(raw, [...baseKeys, 'issue']);
      const issue = parseIssue(raw.issue);
      if (issue.id !== base.issueId) return issueInvalid('Activity issue disagrees.');
      return { ...base, action: raw.action, issue };
    }
    case 'updated': case 'claimed': case 'released': case 'closed': case 'reopened':
      issueRecord(raw, [...baseKeys, 'changes']);
      if (!Array.isArray(raw.changes) || raw.changes.length > ISSUE_FIELDS.length) return issueInvalid('Invalid activity changes.');
      return { ...base, action: raw.action, changes: raw.changes.map(parseChange) };
    case 'comment-added': case 'comment-edited': case 'comment-removed':
      issueRecord(raw, [...baseKeys, 'commentId', 'before', 'after']);
      return { ...base, action: raw.action, commentId: issueUuid(raw.commentId, 'commentId'),
        before: raw.before === null ? null : issueCommentBody(raw.before),
        after: raw.after === null ? null : issueCommentBody(raw.after) };
    case 'linked': case 'unlinked':
      issueRecord(raw, [...baseKeys, 'kind', 'sourceId', 'targetId']);
      return { ...base, action: raw.action, kind: issueLinkKind(raw.kind),
        sourceId: storedIssueId(raw.sourceId), targetId: storedIssueId(raw.targetId) };
    default: return issueInvalid('Invalid activity action.');
  }
}

export function parseIssueWriteResult(value: unknown): IssueWriteResult {
  const raw = issueRecord(value, ['success', 'storeId', 'collectionRevision', 'issue', 'comment', 'relatedIssue']);
  if (raw.success !== true) return issueInvalid('Expected a successful issue result.');
  const issue = parseIssue(raw.issue);
  const comment = raw.comment === undefined ? undefined : parseIssueComment(raw.comment);
  if (comment && comment.issueId !== issue.id) return issueInvalid('Result comment belongs to another issue.');
  return { success: true, storeId: issueUuid(raw.storeId, 'storeId'),
    collectionRevision: issueInteger(raw.collectionRevision, 'collectionRevision', 0), issue,
    ...(comment ? { comment } : {}),
    ...(raw.relatedIssue !== undefined ? { relatedIssue: parseIssue(raw.relatedIssue) } : {}) };
}
