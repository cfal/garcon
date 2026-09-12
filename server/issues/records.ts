import type { Database } from 'bun:sqlite';
import { parseIssue, parseIssueComment, parseIssueWriteResult } from '../../common/issue-records.js';
import { issueNumber } from '../../common/issue-validation.js';
import { issueOwnerKey, type Issue, type IssueActivity, type IssueComment, type IssueWriteResult } from '../../common/issues.js';
import { IssueDomainError, nextIssueCounter } from './errors.js';
import type { IssueMutationContext } from './contracts.js';

export interface StoredIssueRow {
  number: number;
  revision: number;
  project: string;
  status: string;
  resolution: string | null;
  priority: number;
  assignee_key: string | null;
  parent_number: number | null;
  payload_json: string;
}

export interface StoredCommentRow {
  id: string;
  issue_number: number;
  sequence: number;
  revision: number;
  authority_key: string;
  deleted_at: string | null;
  payload_json: string;
}

export function decodeIssue(row: StoredIssueRow): Issue {
  const issue = parseIssue(JSON.parse(row.payload_json));
  const assignee = issue.assignee ? issueOwnerKey(issue.assignee) : null;
  const parent = issue.parentId ? issueNumber(issue.parentId) : null;
  if (issue.number !== row.number || issue.revision !== row.revision || issue.project !== row.project
    || issue.status !== row.status || issue.resolution !== row.resolution || issue.priority !== row.priority
    || assignee !== row.assignee_key || parent !== row.parent_number) throw new Error('Inconsistent issue record.');
  return issue;
}

export function requireIssue(database: Database, id: string): Issue {
  const row = database.query<StoredIssueRow, [number]>('SELECT * FROM issues WHERE number=?').get(issueNumber(id));
  if (!row) throw new IssueDomainError('ISSUE_NOT_FOUND', 'Issue not found.');
  return decodeIssue(row);
}

export function requireIssueRevision(issue: Issue, revision: number): void {
  if (issue.revision !== revision) throw new IssueDomainError('ISSUE_REVISION_CONFLICT', 'Issue changed. Read it before retrying.', issue);
}

export function collectionRevision(database: Database): number {
  const row = database.query<{ revision: number }, []>('SELECT revision FROM issue_meta WHERE singleton=1').get();
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid issue revision.');
  return row.revision;
}

export function requireCollectionRevision(database: Database, expected: number | undefined): number {
  const revision = collectionRevision(database);
  if (expected !== undefined && expected !== revision) {
    throw new IssueDomainError('ISSUE_COLLECTION_CHANGED', 'Issues changed. Refresh before loading the next page.');
  }
  return revision;
}

export function saveIssue(database: Database, issue: Issue): void {
  database.query(`UPDATE issues SET revision=?, project=?, status=?, resolution=?, priority=?,
    assignee_key=?, parent_number=?, payload_json=? WHERE number=?`).run(
    issue.revision, issue.project, issue.status, issue.resolution, issue.priority,
    issue.assignee ? issueOwnerKey(issue.assignee) : null,
    issue.parentId ? issueNumber(issue.parentId) : null, JSON.stringify(issue), issue.number,
  );
  database.query('DELETE FROM issue_labels WHERE issue_number=?').run(issue.number);
  const insert = database.query('INSERT INTO issue_labels VALUES (?, ?)');
  for (const label of issue.labels) insert.run(issue.number, label);
}

export function nextAutoincrement(database: Database, table: 'issues' | 'issue_activity'): number {
  const row = database.query<{ seq: number }, [string]>('SELECT seq FROM sqlite_sequence WHERE name=?').get(table);
  return nextIssueCounter(row?.seq ?? 0);
}

export function decodeComment(row: StoredCommentRow): IssueComment {
  const comment = parseIssueComment(JSON.parse(row.payload_json));
  if (comment.id !== row.id || issueNumber(comment.issueId) !== row.issue_number
    || comment.sequence !== row.sequence || comment.revision !== row.revision || comment.deletedAt !== row.deleted_at) {
    throw new Error('Inconsistent issue comment.');
  }
  return comment;
}

export function requireComment(database: Database, id: string, issueId: string): StoredCommentRow {
  const row = database.query<StoredCommentRow, [string]>('SELECT * FROM issue_comments WHERE id=?').get(id);
  if (!row || row.issue_number !== issueNumber(issueId)) {
    throw new IssueDomainError('ISSUE_COMMENT_NOT_FOUND', 'Comment not found on this issue.');
  }
  return row;
}

export function insertComment(database: Database, comment: IssueComment, authorityKey: string): void {
  database.query(`INSERT INTO issue_comments
    (id,issue_number,sequence,revision,authority_key,deleted_at,payload_json) VALUES (?,?,?,?,?,?,?)`).run(
    comment.id, issueNumber(comment.issueId), comment.sequence, comment.revision, authorityKey,
    comment.deletedAt, JSON.stringify(comment),
  );
}

export function updateComment(database: Database, comment: IssueComment): void {
  database.query('UPDATE issue_comments SET revision=?, deleted_at=?, payload_json=? WHERE id=?')
    .run(comment.revision, comment.deletedAt, JSON.stringify(comment), comment.id);
}

type ActivityContent = IssueActivity extends infer T
  ? T extends IssueActivity ? Omit<T, 'sequence' | 'issueId' | 'at' | 'actor' | 'source'> : never : never;

export function appendActivity(database: Database, issueId: string, content: ActivityContent,
  context: IssueMutationContext, now: string): void {
  const sequence = nextAutoincrement(database, 'issue_activity');
  const activity: IssueActivity = { ...content, sequence, issueId, at: now, actor: context.actor, source: context.source };
  database.query('INSERT INTO issue_activity (sequence,issue_number,operation_key,payload_json) VALUES (?,?,?,?)')
    .run(sequence, issueNumber(issueId), context.operationKey, JSON.stringify(activity));
}

export function readOperation(database: Database, context: IssueMutationContext): IssueWriteResult | null {
  const row = database.query<{ fingerprint: string; result_json: string }, [string]>(
    'SELECT fingerprint,result_json FROM issue_operations WHERE operation_key=?',
  ).get(context.operationKey);
  if (!row) return null;
  if (row.fingerprint !== context.fingerprint) throw new IssueDomainError('ISSUE_REQUEST_CONFLICT', 'This request identity was already used for different issue content.');
  const result = parseIssueWriteResult(JSON.parse(row.result_json));
  if (result.storeId !== context.expectedStoreId) throw new Error('Inconsistent issue operation store.');
  return result;
}
