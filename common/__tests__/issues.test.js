import { describe, expect, test } from 'bun:test';
import { ERROR_CODES } from '../error-codes.js';
import { ISSUE_LIMITS, issueAssigneeQuery } from '../issues.js';
import { parseHttpIssueMutationRequest, parseIssueMutationPayload, parseMarkupIssueMutationPayload } from '../issue-commands.js';
import { parseIssueCommentsQuery, parseIssueHistoryQuery, parseIssueListQuery, parseIssueReadQuery, issueQueryParams } from '../issue-query.js';
import { issueBody, issueCommentBody, issueId, issueLabels, issueProject, issueRef, issueTitle, issueUuid,
  parseIssueAssigneeQuery } from '../issue-validation.js';
import { ISSUE_ERROR_POLICY } from '../../server/issues/errors.js';
import { parseIssue, parseIssueActivity, parseIssueComment, parseIssueWriteResult } from '../issue-records.js';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const STORE = '33333333-3333-4333-8333-333333333333';

describe('issue contracts', () => {
  test('registers all wire codes centrally', () => {
    for (const code of Object.keys(ISSUE_ERROR_POLICY)) expect(ERROR_CODES).toContain(code);
  });

  test('separates transport envelopes and preserves omitted markup project', () => {
    const payload = { action: 'create', input: { title: '  An issue  ' } };
    const markup = parseMarkupIssueMutationPayload(payload);
    expect(markup.input).not.toHaveProperty('project');
    expect(markup.input.title).toBe('An issue');
    expect(() => parseIssueMutationPayload(payload)).toThrow();
    const request = { requestId: REQUEST, expectedStoreId: STORE,
      payload: { ...payload, input: { ...payload.input, project: '  Arbitrary release  ' } } };
    expect(parseHttpIssueMutationRequest(request).payload.input.project).toBe('Arbitrary release');
    for (const changes of [{ expectedStoreId: undefined }, { requestId: 'meaningful-ref' }, { actor: 'forged' }, { ref: 'ref' }]) {
      expect(() => parseHttpIssueMutationRequest({ ...request, ...changes })).toThrow();
    }
    expect(() => parseMarkupIssueMutationPayload({ ...payload, requestId: REQUEST })).toThrow();
  });

  test('normalizes labels and rejects duplicate, invalid, or oversized input', () => {
    expect(issueLabels(['Zulu', 'Alpha', 'alpha'])).toEqual(['Alpha', 'Zulu', 'alpha']);
    for (const labels of [['dup', ' dup '], Array.from({ length: 21 }, (_, n) => String(n)), ['x\u0085y']]) {
      expect(() => issueLabels(labels)).toThrow();
    }
    expect(issueTitle('😀'.repeat(240))).toHaveLength(480);
    expect(() => issueTitle('😀'.repeat(241))).toThrow();
    expect(issueProject('"'.repeat(4096))).toHaveLength(4096);
    expect(() => issueProject('😀'.repeat(1025))).toThrow();
    expect(() => issueProject('')).toThrow();
    expect(issueRef('  fix-draft  ')).toBe('fix-draft');
    expect(() => issueRef('x'.repeat(129))).toThrow();
    for (const text of ['x\n', 'a\u0000b', 'a\u0085b', 'a\u2028b', '\ud800']) {
      expect(() => issueTitle(text)).toThrow();
    }
    expect(issueBody('\u0001\n\t')).toBe('\u0001\n\t');
    expect(() => issueBody('\ud800')).toThrow();
    expect(() => issueBody('a'.repeat(ISSUE_LIMITS.bodyBytes + 1))).toThrow();
    expect(() => issueCommentBody(' \n\t')).toThrow();
  });

  test('validates canonical identities and nonclosed updates', () => {
    expect(issueId('G-42')).toBe('G-42');
    for (const id of ['G-01', 'g-42', 'ISS-42', 'G-0', 'G-9007199254740992']) expect(() => issueId(id)).toThrow();
    expect(issueUuid(REQUEST, 'requestId')).toBe(REQUEST);
    expect(() => issueUuid('11111111-1111-1111-1111-111111111111', 'requestId')).toThrow();
    for (const patch of [{}, { status: 'closed' }, { resolution: 'done' }, { title: undefined }]) {
      expect(() => parseIssueMutationPayload({ action: 'update', issueId: 'G-1', expectedRevision: 1, patch })).toThrow();
    }
  });

  test('parses every mutation shape and rejects surplus fields', () => {
    const target = { issueId: 'G-1', expectedRevision: 1 };
    const commands = [
      { action: 'create', input: { title: 'Issue', project: 'Project' } },
      { action: 'update', ...target, patch: { status: 'in-review' } },
      ...['claim', 'release', 'reopen', 'close'].map((action) => ({ action, ...target })),
      { action: 'comment', issueId: 'G-1', body: 'Comment' },
      { action: 'comment-edit', ...target, commentId: REQUEST, body: 'Edited' },
      { action: 'comment-delete', ...target, commentId: REQUEST },
      ...['link', 'unlink'].map((action) => ({ action, ...target, targetId: 'G-2', targetRevision: 1, kind: 'blocks' })),
    ];
    for (const command of commands) {
      expect(parseIssueMutationPayload(command).action).toBe(command.action);
      expect(() => parseIssueMutationPayload({ ...command, unexpected: true })).toThrow();
    }
  });

  test('fences mutable continuation, leaves immutable history unfenced', () => {
    expect(() => parseIssueListQuery({ beforeNumber: 10 })).toThrow();
    expect(() => parseIssueCommentsQuery({ issueId: 'G-1', beforeSequence: 10 })).toThrow();
    expect(() => parseIssueReadQuery({ issueId: 'G-1', beforeCommentSequence: 10 })).toThrow();
    expect(() => parseIssueReadQuery({ issueId: 'G-1', beforeCommentSequence: 10, expectedCollectionRevision: 2, commentLimit: 0 })).toThrow();
    expect(parseIssueReadQuery({ issueId: 'G-1', commentLimit: 0 }).commentLimit).toBe(0);
    expect(parseIssueHistoryQuery({ issueId: 'G-1', beforeSequence: 10 })).toEqual({ issueId: 'G-1', beforeSequence: 10, limit: 50 });
    expect(() => parseIssueHistoryQuery({ issueId: 'G-1', expectedCollectionRevision: 2 })).toThrow();
  });

  test('encodes assignees without conflating colon or Unicode usernames', () => {
    for (const owner of ['unassigned', { kind: 'chat', chatId: '1000000000000001' }, { kind: 'user', username: 'user:λ' }]) {
      const encoded = issueAssigneeQuery(owner);
      expect(parseIssueAssigneeQuery(encoded)).toEqual(owner);
      expect(issueQueryParams(new URLSearchParams({ assignee: encoded })).assignee).toEqual(owner);
    }
    expect(() => issueQueryParams(new URLSearchParams('limit=10&limit=20'))).toThrow();
    expect(() => issueQueryParams(new URLSearchParams('ready=1'))).toThrow();
    expect(() => parseIssueListQuery(issueQueryParams(new URLSearchParams('__proto__=bad')))).toThrow();
  });

  test('round-trips typed domain records and rejects private or contradictory fields', () => {
    const actor = { kind: 'user', username: 'local', principalMode: 'local', declaredChatId: null };
    const issue = { id: 'G-1', number: 1, revision: 1, title: 'Synthetic issue', description: 'Exact\nbody',
      project: 'Project', status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: actor };
    const comment = { id: REQUEST, issueId: 'G-1', sequence: 1, revision: 1, body: 'Comment', author: actor,
      createdAt: issue.createdAt, updatedAt: issue.updatedAt, deletedAt: null };
    expect(parseIssue(issue)).toEqual(issue);
    expect(parseIssueComment(comment)).toEqual(comment);
    expect(parseIssueWriteResult({ success: true, storeId: STORE, collectionRevision: 2, issue, comment }).comment).toEqual(comment);
    const activity = { sequence: 1, issueId: 'G-1', at: issue.createdAt, actor, source: null,
      action: 'updated', changes: [{ field: 'priority', before: 2, after: 1 }] };
    expect(parseIssueActivity(activity)).toEqual(activity);
    expect(() => parseIssueActivity({ ...activity, changes: [{ field: 'priority', before: 2, after: 'High' }] })).toThrow();
    expect(() => parseIssue({ ...issue, resolution: 'done' })).toThrow();
    expect(() => parseIssue({ ...issue, number: 2 })).toThrow();
    expect(() => parseIssueComment({ ...comment, body: null })).toThrow();
    expect(() => parseIssueComment({ ...comment, authorityKey: 'private' })).toThrow();
    expect(() => parseIssueWriteResult({ success: true, storeId: STORE, collectionRevision: 2, issue,
      comment: { ...comment, issueId: 'G-2' } })).toThrow();
  });
});
