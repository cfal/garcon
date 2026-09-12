import { describe, expect, test } from 'bun:test';
import { parseIssueBootstrap, parseIssueCommentsPage, parseIssueCounts, parseIssueDetail,
  parseIssueFacets, parseIssueHistoryPage, parseIssuePage, parseIssueProjectDefault } from '../issue-responses.js';
import { IssuesInvalidatedMessage, parseServerWsMessage } from '../ws-events.js';

const version = { storeId: '11111111-1111-4111-8111-111111111111', collectionRevision: 3 };
const actor = { kind: 'user', username: 'local', principalMode: 'local', declaredChatId: null };
const issue = { id: 'ISS-1', number: 1, revision: 1, title: 'Synthetic', description: '', project: 'Synthetic project',
  status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: actor };
const comment = { id: '22222222-2222-4222-8222-222222222222', issueId: issue.id, sequence: 1, revision: 1,
  body: 'Synthetic comment', author: actor, createdAt: issue.createdAt, updatedAt: issue.createdAt, deletedAt: null, canEdit: true };
const comments = { ...version, items: [comment], nextBeforeSequence: null };

describe('issue response contracts', () => {
  test('round-trips every projection without private fields', () => {
    const { description: _description, ...fields } = issue;
    const page = { ...version, items: [{ ...fields, blockedByCount: 0, commentCount: 1 }], nextBeforeNumber: null };
    expect(parseIssuePage(page)).toEqual(page);
    expect(parseIssueCommentsPage(comments)).toEqual(comments);
    const detail = { ...version, issue: { ...issue, description: null }, links: [], comments };
    expect(parseIssueDetail(detail)).toEqual(detail);
    const history = { ...version, items: [{ sequence: 1, issueId: issue.id, at: issue.createdAt,
      actor, source: null, action: 'created', issue }], nextBeforeSequence: null };
    expect(parseIssueHistoryPage(history)).toEqual(history);
    const bootstrap = { ...version, viewerKey: '["principal","local","local"]' };
    expect(parseIssueBootstrap(bootstrap)).toEqual(bootstrap);
    const counts = { ...version, counts: { open: 1, 'in-progress': 0, 'in-review': 0, closed: 0 } };
    expect(parseIssueCounts(counts)).toEqual(counts);
    expect(parseIssueFacets({ ...version, values: ['Project'] }).values).toEqual(['Project']);
    expect(parseIssueProjectDefault({ project: '/repo', kind: 'repository' })).toEqual({ project: '/repo', kind: 'repository' });
    expect(() => parseIssueBootstrap({ ...bootstrap, token: 'private' })).toThrow();
    expect(() => parseIssueCommentsPage({ ...comments, items: [{ ...comment, authorityKey: 'private' }] })).toThrow();
  });

  test('rejects inconsistent detail identities, versions, ordering and continuations', () => {
    const detail = { ...version, issue, links: [], comments };
    for (const patch of [{ storeId: '33333333-3333-4333-8333-333333333333' }, { collectionRevision: 4 },
      { items: [{ ...comment, issueId: 'ISS-2' }] }]) {
      expect(() => parseIssueDetail({ ...detail, comments: { ...comments, ...patch } })).toThrow();
    }
    expect(() => parseIssueCommentsPage({ ...comments, nextBeforeSequence: 2 })).toThrow();
    expect(() => parseIssueCommentsPage({ ...comments, items: [comment, comment] })).toThrow();
    expect(() => parseIssueCommentsPage({ ...comments, items: [{ ...comment, body: null, deletedAt: issue.createdAt }] })).toThrow();
    expect(() => parseIssueDetail({ ...detail, links: [{ sourceId: 'ISS-2', targetId: 'ISS-3', kind: 'blocks' }] })).toThrow();
    expect(() => parseIssuePage({ ...version, items: [], nextBeforeNumber: 1 })).toThrow();
  });

  test('accepts only a bounded revision-only WebSocket invalidation', () => {
    expect(parseServerWsMessage(JSON.parse(JSON.stringify(new IssuesInvalidatedMessage(3)))))
      .toEqual(new IssuesInvalidatedMessage(3));
    for (const revision of [-1, 0.5, '3', Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseServerWsMessage({ type: 'issues-invalidated', revision })).toBeNull();
    }
    expect(parseServerWsMessage({ type: 'issues-invalidated', revision: 3, body: 'private' })).toBeNull();
    expect(parseServerWsMessage({ type: 'issues-invalidated' })).toBeNull();
  });
});
