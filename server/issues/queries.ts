import type { Database } from 'bun:sqlite';
import { parseIssueActivity } from '../../common/issue-records.js';
import { issueBytes, issueNumber } from '../../common/issue-validation.js';
import { ISSUE_LIMITS, issueOwnerKey, type IssueActivity, type IssueCollectionVersion,
  type IssueCommentsQuery, type IssueCommentView, type IssueCounts, type IssueDetail, type IssueFacets,
  type IssueHistoryQuery, type IssueLink, type IssueListQuery, type IssuePage, type IssueReadQuery,
  type IssueSequencePage, type IssueSummary } from '../../common/issues.js';
import { issueAuthorityKey, type IssueAuthority } from './contracts.js';
import { IssueDomainError } from './errors.js';
import { collectionRevision, decodeComment, decodeIssue, requireCollectionRevision, requireIssue,
  type StoredCommentRow, type StoredIssueRow } from './records.js';

export interface IssueReadBudget {
  readonly maxBytes: number;
  readonly measure: (value: unknown) => number;
}

export const HTTP_ISSUE_BUDGET: IssueReadBudget = {
  maxBytes: ISSUE_LIMITS.httpBytes,
  measure: (value) => issueBytes(JSON.stringify(value)),
};

export function packIssueItems<T, R>(candidates: readonly T[], limit: number,
  build: (items: readonly T[], more: boolean) => R, budget: IssueReadBudget): R {
  const items: T[] = [];
  const empty = build(items, false);
  if (budget.measure(empty) > budget.maxBytes) throw oversized();
  for (const candidate of candidates.slice(0, limit)) {
    const next = [...items, candidate];
    if (budget.measure(build(next, candidates.length > next.length)) > budget.maxBytes) {
      if (!items.length) throw oversized();
      break;
    }
    items.push(candidate);
  }
  return build(items, candidates.length > items.length);
}

function oversized(): IssueDomainError {
  return new IssueDomainError('ISSUE_RESULT_TOO_LARGE', 'Issue content exceeds the response limit. Request less content or use another transport.');
}

const unresolvedBlockers = `SELECT count(*) FROM issue_links bl JOIN issues blocker ON blocker.number=bl.source_number
  WHERE bl.target_number=i.number AND bl.kind='blocks' AND NOT (blocker.status='closed' AND blocker.resolution='done')`;

function literalLike(text: string): string {
  return text.replace(/[\\%_]/gu, '\\$&');
}

function listFilter(query: IssueListQuery): { sql: string; values: (string | number)[] } {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  const add = (condition: string, value: string | number) => { conditions.push(condition); values.push(value); };
  if (query.project !== undefined) add('i.project=?', query.project);
  if (query.status !== undefined) add('i.status=?', query.status);
  else if (!query.includeClosed) conditions.push("i.status<>'closed'");
  if (query.priority !== undefined) add('i.priority=?', query.priority);
  if (query.label !== undefined) add('EXISTS(SELECT 1 FROM issue_labels l WHERE l.issue_number=i.number AND l.label=?)', query.label);
  if (query.assignee === 'unassigned') conditions.push('i.assignee_key IS NULL');
  else if (query.assignee) add('i.assignee_key=?', issueOwnerKey(query.assignee));
  if (query.ready !== undefined) {
    const ready = `(i.status='open' AND i.assignee_key IS NULL AND (${unresolvedBlockers})=0)`;
    conditions.push(query.ready ? ready : `NOT ${ready}`);
  }
  if (query.query !== undefined) {
    conditions.push(`(json_extract(i.payload_json,'$.title') LIKE ? ESCAPE '\\'
      OR json_extract(i.payload_json,'$.description') LIKE ? ESCAPE '\\' OR 'ISS-'||i.number=?)`);
    const search = `%${literalLike(query.query)}%`;
    values.push(search, search, query.query);
  }
  if (query.beforeNumber !== undefined) add('i.number<?', query.beforeNumber);
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

export function listIssues(database: Database, storeId: string, query: IssueListQuery, budget: IssueReadBudget): IssuePage {
  const collectionRevision = requireCollectionRevision(database, query.expectedCollectionRevision);
  const filter = listFilter(query);
  const limit = query.limit ?? ISSUE_LIMITS.defaultPage;
  const rows = database.query<StoredIssueRow & { blocked_count: number; comment_count: number }, (string | number)[]>(`
    SELECT i.*, (${unresolvedBlockers}) AS blocked_count,
      (SELECT count(*) FROM issue_comments c WHERE c.issue_number=i.number AND c.deleted_at IS NULL) AS comment_count
    FROM issues i ${filter.sql} ORDER BY i.number DESC LIMIT ?
  `).all(...filter.values, limit + 1);
  const summaries = rows.map((row): IssueSummary => {
    const { description: _description, ...issue } = decodeIssue(row);
    return { ...issue, blockedByCount: row.blocked_count, commentCount: row.comment_count };
  });
  return packIssueItems(summaries, limit, (items, more) => ({ storeId, collectionRevision, items,
    nextBeforeNumber: more ? items.at(-1)!.number : null }), budget);
}

export function countIssues(database: Database, storeId: string, query: IssueListQuery): IssueCounts {
  const collectionRevision = requireCollectionRevision(database, query.expectedCollectionRevision);
  const filter = listFilter(query);
  const rows = database.query<{ status: keyof IssueCounts['counts']; count: number }, (string | number)[]>(
    `SELECT i.status,count(*) AS count FROM issues i ${filter.sql} GROUP BY i.status`,
  ).all(...filter.values);
  const counts = { open: 0, 'in-progress': 0, 'in-review': 0, closed: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return { storeId, collectionRevision, counts };
}

function commentCandidates(database: Database, query: IssueCommentsQuery, authority: IssueAuthority): IssueCommentView[] {
  const rows = database.query<StoredCommentRow, number[]>(`
    SELECT * FROM issue_comments WHERE issue_number=? AND sequence<? ORDER BY sequence DESC LIMIT ?
  `).all(issueNumber(query.issueId), query.beforeSequence ?? Number.MAX_SAFE_INTEGER,
    (query.limit ?? ISSUE_LIMITS.defaultPage) + 1);
  const authorityKey = issueAuthorityKey(authority);
  return rows.map((row) => ({ ...decodeComment(row), canEdit: row.deleted_at === null && row.authority_key === authorityKey }));
}

function sequencePage<T extends { sequence: number }>(version: IssueCollectionVersion,
  items: readonly T[], more: boolean): IssueSequencePage<T> {
  return { ...version, items: [...items].reverse(), nextBeforeSequence: more ? items.at(-1)!.sequence : null };
}

export function readIssueComments(database: Database, storeId: string, query: IssueCommentsQuery,
  authority: IssueAuthority, budget: IssueReadBudget): IssueSequencePage<IssueCommentView> {
  const collectionRevision = requireCollectionRevision(database, query.expectedCollectionRevision);
  requireIssue(database, query.issueId);
  return packIssueItems(commentCandidates(database, query, authority), query.limit ?? ISSUE_LIMITS.defaultPage,
    (items, more) => sequencePage({ storeId, collectionRevision }, items, more), budget);
}

export function readIssueDetail(database: Database, storeId: string, query: IssueReadQuery,
  authority: IssueAuthority, budget: IssueReadBudget): IssueDetail {
  const collectionRevision = requireCollectionRevision(database, query.expectedCollectionRevision);
  const current = requireIssue(database, query.issueId);
  const issue = { ...current, description: query.includeDescription === false ? null : current.description };
  const links = database.query<{ source_number: number; target_number: number; kind: IssueLink['kind'] }, [number, number]>(
    'SELECT * FROM issue_links WHERE source_number=? OR target_number=? ORDER BY source_number,target_number,kind',
  ).all(current.number, current.number).map((link) => ({ sourceId: `ISS-${link.source_number}`,
    targetId: `ISS-${link.target_number}`, kind: link.kind }));
  const limit = query.commentLimit ?? ISSUE_LIMITS.defaultPage;
  const candidates = limit === 0 ? [] : commentCandidates(database, {
    issueId: query.issueId, limit, beforeSequence: query.beforeCommentSequence,
  }, authority);
  const version = { storeId, collectionRevision };
  return packIssueItems(candidates, limit, (items, more) => ({ ...version, issue, links,
    comments: sequencePage(version, items, more) }), budget);
}

export function readIssueHistory(database: Database, storeId: string, query: IssueHistoryQuery,
  budget: IssueReadBudget): IssueSequencePage<IssueActivity> {
  requireIssue(database, query.issueId);
  const version = { storeId, collectionRevision: collectionRevision(database) };
  const limit = query.limit ?? ISSUE_LIMITS.defaultPage;
  const rows = database.query<{ sequence: number; payload_json: string }, number[]>(`
    SELECT sequence,payload_json FROM issue_activity WHERE issue_number=? AND sequence<? ORDER BY sequence DESC LIMIT ?
  `).all(issueNumber(query.issueId), query.beforeSequence ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const events = rows.map((row) => {
    const activity = parseIssueActivity(JSON.parse(row.payload_json));
    if (activity.sequence !== row.sequence || activity.issueId !== query.issueId) throw new Error('Inconsistent issue activity.');
    return activity;
  });
  return packIssueItems(events, limit, (items, more) => sequencePage(version, items, more), budget);
}

export function issueFacets(database: Database, storeId: string, field: 'project' | 'label', prefix: string): IssueFacets {
  const sql = field === 'project'
    ? "SELECT DISTINCT project AS value FROM issues WHERE project LIKE ? ESCAPE '\\' ORDER BY project LIMIT 50"
    : "SELECT DISTINCT label AS value FROM issue_labels WHERE label LIKE ? ESCAPE '\\' ORDER BY label LIMIT 50";
  const values = database.query<{ value: string }, [string]>(sql).all(`${literalLike(prefix)}%`).map((row) => row.value);
  return { storeId, collectionRevision: collectionRevision(database), values };
}
