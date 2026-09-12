import { ISSUE_LIMITS, issueAssigneeQuery, type IssueListQuery, type IssueReadQuery,
  type IssueCommentsQuery, type IssueHistoryQuery } from './issues.js';
import { issueBoolean, issueId, issueInteger, issueInvalid, issueLine, issueOwner, issuePriority,
  issueProject, issueRecord, issueStatus, parseIssueAssigneeQuery } from './issue-validation.js';

const listKeys = ['project', 'status', 'includeClosed', 'priority', 'label', 'assignee', 'ready',
  'query', 'beforeNumber', 'expectedCollectionRevision', 'limit'];

function optionalInteger(raw: Record<string, unknown>, key: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (raw[key] === undefined) return undefined;
  return issueInteger(raw[key], key, minimum, maximum);
}

export function parseIssueListQuery(value: unknown): IssueListQuery {
  const raw = issueRecord(value, listKeys);
  const beforeNumber = optionalInteger(raw, 'beforeNumber');
  const expectedCollectionRevision = optionalInteger(raw, 'expectedCollectionRevision', 0);
  requireCommentRevision(beforeNumber, expectedCollectionRevision);
  let assignee: IssueListQuery['assignee'];
  if (raw.assignee === 'unassigned') assignee = 'unassigned';
  else if (raw.assignee !== undefined) assignee = issueOwner(raw.assignee);
  return {
    ...(raw.project !== undefined ? { project: issueProject(raw.project) } : {}),
    ...(raw.status !== undefined ? { status: issueStatus(raw.status) } : {}),
    ...(raw.includeClosed !== undefined ? { includeClosed: issueBoolean(raw.includeClosed) } : {}),
    ...(raw.priority !== undefined ? { priority: issuePriority(raw.priority) } : {}),
    ...(raw.label !== undefined ? { label: issueLine(raw.label, 'label', ISSUE_LIMITS.labelCodePoints) } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(raw.ready !== undefined ? { ready: issueBoolean(raw.ready) } : {}),
    ...(raw.query !== undefined ? { query: issueLine(raw.query, 'query', 256) } : {}),
    ...(beforeNumber !== undefined ? { beforeNumber } : {}),
    ...(expectedCollectionRevision !== undefined ? { expectedCollectionRevision } : {}),
    limit: optionalInteger(raw, 'limit', 1, ISSUE_LIMITS.page) ?? ISSUE_LIMITS.defaultPage,
  };
}

export function parseIssueReadQuery(value: unknown): IssueReadQuery {
  const raw = issueRecord(value, ['issueId', 'includeDescription', 'commentLimit',
    'beforeCommentSequence', 'expectedCollectionRevision']);
  const beforeCommentSequence = optionalInteger(raw, 'beforeCommentSequence');
  const expectedCollectionRevision = optionalInteger(raw, 'expectedCollectionRevision', 0);
  const commentLimit = optionalInteger(raw, 'commentLimit', 0, ISSUE_LIMITS.page) ?? ISSUE_LIMITS.defaultPage;
  requireCommentRevision(beforeCommentSequence, expectedCollectionRevision);
  if (beforeCommentSequence !== undefined && commentLimit === 0) return issueInvalid('Comment continuation requires a positive limit.');
  return {
    issueId: issueId(raw.issueId),
    includeDescription: raw.includeDescription === undefined ? true : issueBoolean(raw.includeDescription),
    commentLimit,
    ...(beforeCommentSequence !== undefined ? { beforeCommentSequence } : {}),
    ...(expectedCollectionRevision !== undefined ? { expectedCollectionRevision } : {}),
  };
}

export function parseIssueCommentsQuery(value: unknown): IssueCommentsQuery {
  const raw = issueRecord(value, ['issueId', 'limit', 'beforeSequence', 'expectedCollectionRevision']);
  const beforeSequence = optionalInteger(raw, 'beforeSequence');
  const expectedCollectionRevision = optionalInteger(raw, 'expectedCollectionRevision', 0);
  requireCommentRevision(beforeSequence, expectedCollectionRevision);
  return { issueId: issueId(raw.issueId),
    limit: optionalInteger(raw, 'limit', 1, ISSUE_LIMITS.page) ?? ISSUE_LIMITS.defaultPage,
    ...(beforeSequence !== undefined ? { beforeSequence } : {}),
    ...(expectedCollectionRevision !== undefined ? { expectedCollectionRevision } : {}) };
}

export function parseIssueHistoryQuery(value: unknown): IssueHistoryQuery {
  const raw = issueRecord(value, ['issueId', 'limit', 'beforeSequence']);
  const beforeSequence = optionalInteger(raw, 'beforeSequence');
  return { issueId: issueId(raw.issueId),
    limit: optionalInteger(raw, 'limit', 1, ISSUE_LIMITS.page) ?? ISSUE_LIMITS.defaultPage,
    ...(beforeSequence !== undefined ? { beforeSequence } : {}) };
}

function requireCommentRevision(cursor: number | undefined, revision: number | undefined): void {
  if (cursor !== undefined && revision === undefined) return issueInvalid('Continuation requires expectedCollectionRevision.');
}

export function issueQueryParams(params: URLSearchParams): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, text] of params) {
    if (Object.hasOwn(raw, key)) return issueInvalid('Duplicate query parameter.');
    if (['limit', 'priority', 'beforeNumber', 'expectedCollectionRevision', 'commentLimit',
      'beforeCommentSequence', 'beforeSequence'].includes(key)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(text)) return issueInvalid('Invalid numeric query parameter.');
      raw[key] = Number(text);
    } else if (['includeClosed', 'ready', 'includeDescription'].includes(key)) {
      if (text !== 'true' && text !== 'false') return issueInvalid('Invalid boolean query parameter.');
      raw[key] = text === 'true';
    } else if (key === 'assignee') {
      raw[key] = parseIssueAssigneeQuery(text);
    } else {
      Object.defineProperty(raw, key, { value: text, enumerable: true, configurable: true });
    }
  }
  return raw;
}

export function issueSearchParams(query: IssueListQuery | IssueReadQuery | IssueCommentsQuery | IssueHistoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (key === 'assignee' && 'assignee' in query && query.assignee && query.assignee !== 'unassigned') {
      params.set(key, issueAssigneeQuery(query.assignee));
    } else params.set(key, String(value));
  }
  return params;
}
