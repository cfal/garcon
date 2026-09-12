import { parseIssue, parseIssueActivity, parseIssueComment } from './issue-records.js';
import { issueBoolean, issueId, issueInteger, issueInvalid, issueLinkKind, issueProject,
  issueRecord, issueString, issueUuid } from './issue-validation.js';
import { ISSUE_LIMITS, ISSUE_STATUSES, type IssueActivity, type IssueBootstrap, type IssueCollectionVersion,
  type IssueCommentView, type IssueCounts, type IssueDetail, type IssueFacets, type IssueLink,
  type IssuePage, type IssueProjectDefault, type IssueSequencePage, type IssueSummary } from './issues.js';

function version(raw: Record<string, unknown>): IssueCollectionVersion {
  return { storeId: issueUuid(raw.storeId, 'storeId'),
    collectionRevision: issueInteger(raw.collectionRevision, 'collectionRevision', 0) };
}

function items<T>(value: unknown, parse: (item: unknown) => T, max: number = ISSUE_LIMITS.page): T[] {
  if (!Array.isArray(value) || value.length > max) return issueInvalid('Invalid issue response items.');
  return value.map(parse);
}

function cursor(value: unknown): number | null {
  return value === null ? null : issueInteger(value, 'continuation');
}

export function parseIssueBootstrap(value: unknown): IssueBootstrap {
  const raw = issueRecord(value, ['storeId', 'collectionRevision', 'viewerKey']);
  const viewerKey = issueString(raw.viewerKey, 'viewerKey');
  if (!viewerKey || viewerKey.length > 2048) return issueInvalid('Invalid viewer identity.');
  return { ...version(raw), viewerKey };
}

export function parseIssueSummary(value: unknown): IssueSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return issueInvalid('Invalid issue summary.');
  const { blockedByCount, commentCount, ...raw } = value as Record<string, unknown>;
  if (Object.hasOwn(raw, 'description')) return issueInvalid('Issue summary contains a description.');
  const { description: _description, ...issue } = parseIssue({ ...raw, description: '' });
  return { ...issue, blockedByCount: issueInteger(blockedByCount, 'blockedByCount', 0, ISSUE_LIMITS.links),
    commentCount: issueInteger(commentCount, 'commentCount', 0) };
}

export function parseIssuePage(value: unknown): IssuePage {
  const raw = issueRecord(value, ['storeId', 'collectionRevision', 'items', 'nextBeforeNumber']);
  const entries = items(raw.items, parseIssueSummary);
  const nextBeforeNumber = cursor(raw.nextBeforeNumber);
  if (entries.some((entry, index) => index > 0 && entry.number >= entries[index - 1]!.number)
    || (nextBeforeNumber !== null && nextBeforeNumber !== entries.at(-1)?.number)) {
    return issueInvalid('Invalid issue page ordering or continuation.');
  }
  return { ...version(raw), items: entries, nextBeforeNumber };
}

export function parseIssueCommentView(value: unknown): IssueCommentView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return issueInvalid('Invalid comment view.');
  const { canEdit, ...raw } = value as Record<string, unknown>;
  const comment = parseIssueComment(raw);
  const editable = issueBoolean(canEdit);
  if (editable && comment.deletedAt !== null) return issueInvalid('A removed comment cannot be editable.');
  return { ...comment, canEdit: editable };
}

function sequencePage<T extends { sequence: number; issueId: string }>(value: unknown,
  parse: (item: unknown) => T): IssueSequencePage<T> {
  const raw = issueRecord(value, ['storeId', 'collectionRevision', 'items', 'nextBeforeSequence']);
  const entries = items(raw.items, parse);
  const nextBeforeSequence = cursor(raw.nextBeforeSequence);
  if (entries.some((entry, index) => entry.issueId !== entries[0]!.issueId
    || (index > 0 && entry.sequence <= entries[index - 1]!.sequence))
    || (nextBeforeSequence !== null && nextBeforeSequence !== entries[0]?.sequence)) {
    return issueInvalid('Invalid issue sequence ordering or continuation.');
  }
  return { ...version(raw), items: entries, nextBeforeSequence };
}

export function parseIssueCommentsPage(value: unknown): IssueSequencePage<IssueCommentView> {
  return sequencePage(value, parseIssueCommentView);
}

export function parseIssueHistoryPage(value: unknown): IssueSequencePage<IssueActivity> {
  return sequencePage(value, parseIssueActivity);
}

function parseLink(value: unknown): IssueLink {
  const raw = issueRecord(value, ['sourceId', 'targetId', 'kind']);
  const sourceId = issueId(raw.sourceId);
  const targetId = issueId(raw.targetId);
  if (sourceId === targetId) return issueInvalid('Invalid self link.');
  return { sourceId, targetId, kind: issueLinkKind(raw.kind) };
}

export function parseIssueDetail(value: unknown): IssueDetail {
  const raw = issueRecord(value, ['storeId', 'collectionRevision', 'issue', 'links', 'comments']);
  if (!raw.issue || typeof raw.issue !== 'object' || Array.isArray(raw.issue)) return issueInvalid('Invalid issue detail.');
  const issueRaw = raw.issue as Record<string, unknown>;
  const omitted = issueRaw.description === null;
  const current = parseIssue(omitted ? { ...issueRaw, description: '' } : issueRaw);
  const issue = { ...current, description: omitted ? null : current.description };
  const collection = version(raw);
  const comments = parseIssueCommentsPage(raw.comments);
  const links = items(raw.links, parseLink, ISSUE_LIMITS.links);
  if (comments.storeId !== collection.storeId || comments.collectionRevision !== collection.collectionRevision
    || comments.items.some((comment) => comment.issueId !== issue.id)
    || links.some((link) => link.sourceId !== issue.id && link.targetId !== issue.id)) {
    return issueInvalid('Issue detail projections disagree.');
  }
  return { ...collection, issue, links, comments };
}

export function parseIssueCounts(value: unknown): IssueCounts {
  const raw = issueRecord(value, ['storeId', 'collectionRevision', 'counts']);
  const counts = issueRecord(raw.counts, ISSUE_STATUSES);
  return { ...version(raw), counts: { open: issueInteger(counts.open, 'open', 0),
    'in-progress': issueInteger(counts['in-progress'], 'in-progress', 0),
    'in-review': issueInteger(counts['in-review'], 'in-review', 0),
    closed: issueInteger(counts.closed, 'closed', 0) } };
}

export function parseIssueFacets(value: unknown): IssueFacets {
  const raw = issueRecord(value, ['storeId', 'collectionRevision', 'values']);
  return { ...version(raw), values: items(raw.values, issueProject, 50) };
}

export function parseIssueProjectDefault(value: unknown): IssueProjectDefault {
  const raw = issueRecord(value, ['project', 'kind']);
  if (raw.kind !== 'repository' && raw.kind !== 'folder') return issueInvalid('Invalid project provenance.');
  return { project: issueProject(raw.project), kind: raw.kind };
}
