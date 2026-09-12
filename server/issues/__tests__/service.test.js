import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { issueFixture, caller, CHAT_ID, OTHER_CHAT_ID, principal } from './fixture.js';
import { deriveIssueCaller } from '../contracts.js';

let fixture;
beforeEach(() => { fixture = issueFixture(); });
afterEach(() => { fixture.cleanup(); });

function change(issue, action, extra = {}) {
  return fixture.write({ action, issueId: issue.id, expectedRevision: issue.revision, ...extra });
}

describe('issue transactions and workflow', () => {
  test('persists exact domain state and original retries across restart and later edits', () => {
    const request = fixture.request({ action: 'create', input: { title: 'Original', project: 'Release / arbitrary' } });
    const first = fixture.service.executeHttp(request, caller);
    const latest = change(first.issue, 'update', { patch: { title: 'Current', project: 'New grouping' } });
    fixture.reopen();
    expect(fixture.service.executeHttp(request, caller)).toEqual(first);
    expect(fixture.service.read({ issueId: first.issue.id }, caller.authority).issue).toEqual(latest.issue);
    expect(fixture.invalidations).toEqual([1, 2]);
    expect(() => fixture.service.executeHttp({ ...request, payload: { action: 'create', input: { title: 'Changed', project: 'Release / arbitrary' } } }, caller))
      .toThrow(expect.objectContaining({ code: 'ISSUE_REQUEST_CONFLICT' }));
  });

  test('checks store before retry identity and writes', () => {
    const request = fixture.request({ action: 'create', input: { title: 'Issue', project: 'Project' } });
    fixture.service.executeHttp(request, caller);
    expect(() => fixture.service.executeHttp({ ...request, expectedStoreId: crypto.randomUUID() }, caller))
      .toThrow(expect.objectContaining({ code: 'ISSUE_STORE_CHANGED' }));
    expect(fixture.service.list({}).items).toHaveLength(1);
  });

  test('no-op writes retain retry results but add no revisions or activity', () => {
    const first = fixture.create();
    const result = change(first.issue, 'update', { patch: { title: first.issue.title } });
    expect(result).toEqual(first);
    expect(change(first.issue, 'release')).toEqual(first);
    expect(change(first.issue, 'reopen')).toEqual(first);
    expect(fixture.service.history({ issueId: first.issue.id }).items).toHaveLength(1);
    expect(fixture.invalidations).toEqual([1]);
  });

  test('same-owner Open claim starts work; repeated claim is a no-op', () => {
    const created = fixture.create({ assignee: { kind: 'user', username: 'local' } });
    const claimed = change(created.issue, 'claim');
    expect(claimed.issue.status).toBe('in-progress');
    expect(claimed.issue.revision).toBe(2);
    expect(change(claimed.issue, 'claim')).toEqual(claimed);
    const review = change(claimed.issue, 'update', { patch: { status: 'in-review' } });
    expect(change(review.issue, 'claim')).toEqual(review);
  });

  test('concurrent claimants have one winner without partial history', async () => {
    const created = fixture.create();
    const request = { action: 'claim', issueId: created.issue.id, expectedRevision: 1 };
    const results = await Promise.allSettled([
      Promise.resolve().then(() => fixture.write(request, { fromChatId: CHAT_ID })),
      Promise.resolve().then(() => fixture.write(request, { fromChatId: OTHER_CHAT_ID })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const issue = fixture.service.read({ issueId: created.issue.id }, caller.authority).issue;
    expect(issue.assignee).toEqual({ kind: 'chat', chatId: CHAT_ID });
    expect(() => change(issue, 'release')).toThrow(expect.objectContaining({ code: 'ISSUE_ALREADY_CLAIMED' }));
    expect(() => change(issue, 'claim')).toThrow(expect.objectContaining({ code: 'ISSUE_ALREADY_CLAIMED' }));
    const updated = change(issue, 'update', { patch: { assignee: null } });
    expect(updated.issue.assignee).toBeNull();
    expect(fixture.service.history({ issueId: issue.id }).items.map((entry) => entry.action)).toEqual(['created', 'claimed', 'updated']);
  });

  test('closed transitions are explicit; closed metadata and owner release stay allowed', () => {
    const created = fixture.create();
    const claimed = change(created.issue, 'claim');
    const closed = change(claimed.issue, 'close', { resolution: 'canceled', comment: 'No longer needed.' });
    expect(closed.issue).toMatchObject({ status: 'closed', resolution: 'canceled', revision: 3 });
    expect(closed.collectionRevision).toBe(3);
    expect(closed.comment.body).toBe('No longer needed.');
    expect(() => change(closed.issue, 'update', { patch: { title: 'Must roll back', status: 'open' } }))
      .toThrow(expect.objectContaining({ code: 'ISSUE_INVALID_TRANSITION' }));
    expect(() => change(closed.issue, 'claim')).toThrow(expect.objectContaining({ code: 'ISSUE_INVALID_TRANSITION' }));
    expect(() => change(closed.issue, 'close', { resolution: 'done' })).toThrow(expect.objectContaining({ code: 'ISSUE_INVALID_TRANSITION' }));
    const metadata = change(closed.issue, 'update', { patch: { title: 'Closed title' } });
    const released = change(metadata.issue, 'release');
    expect(released.issue.status).toBe('closed');
    expect(released.issue.assignee).toBeNull();
    const reopened = change(released.issue, 'reopen');
    expect(reopened.issue).toMatchObject({ status: 'open', resolution: null });
    expect(fixture.service.history({ issueId: created.issue.id }).items.map((entry) => entry.action))
      .toEqual(['created', 'claimed', 'closed', 'comment-added', 'updated', 'released', 'reopened']);
  });

  test('retry lookup precedes deleted-chat existence, but not current settings', () => {
    const declared = deriveIssueCaller(principal, CHAT_ID);
    const request = fixture.request({ action: 'create', input: { title: 'Declared', project: 'Project' } }, { fromChatId: CHAT_ID });
    const first = fixture.service.executeHttp(request, declared);
    fixture.chats.delete(CHAT_ID);
    expect(fixture.service.executeHttp(request, declared)).toEqual(first);
    fixture.controls.enabled = false;
    expect(() => fixture.service.executeHttp(request, declared)).toThrow(expect.objectContaining({ code: 'ISSUE_COMMANDS_DISABLED' }));
    fixture.controls.enabled = true;
    expect(fixture.service.executeHttp(request, declared)).toEqual(first);
    expect(() => fixture.write({ action: 'comment', issueId: first.issue.id, body: 'New' }, { fromChatId: CHAT_ID }))
      .toThrow(expect.objectContaining({ code: 'ISSUE_CHAT_NOT_FOUND' }));
    expect(fixture.service.list({}).items).toHaveLength(1);
  });

  test('disabled commands leave human management available and retain issues after source deletion', () => {
    fixture.controls.enabled = false;
    const first = fixture.create();
    expect(() => fixture.markup({ action: 'claim', issueId: first.issue.id, expectedRevision: 1 }, 'claim'))
      .toThrow(expect.objectContaining({ code: 'ISSUE_COMMANDS_DISABLED' }));
    fixture.controls.enabled = true;
    const second = fixture.markup({ action: 'create', input: { title: 'Observed', project: 'Project' } }, 'create');
    expect(second.issue.createdBy).toEqual({ kind: 'chat', chatId: CHAT_ID, provenance: 'observed' });
    fixture.chats.delete(CHAT_ID);
    expect(fixture.service.list({}).items).toHaveLength(2);
  });

  test('rejects forged user assignment from markup and foreign users from HTTP', () => {
    expect(() => fixture.markup({ action: 'create', input: { title: 'Bad', project: 'Project', assignee: { kind: 'user', username: 'local' } } }, 'bad'))
      .toThrow(expect.objectContaining({ code: 'ISSUE_VALIDATION_FAILED' }));
    expect(() => fixture.create({ assignee: { kind: 'user', username: 'someone-else' } }))
      .toThrow(expect.objectContaining({ code: 'ISSUE_VALIDATION_FAILED' }));
    expect(fixture.service.list({}).items).toEqual([]);
  });

  test('cancellation is before effects and postcommit listener failure cannot undo success', () => {
    const abort = new AbortController();
    abort.abort();
    expect(() => fixture.service.executeHttp(fixture.request({ action: 'create', input: { title: 'Not created', project: 'Project' } }), caller, abort.signal)).toThrow();
    expect(fixture.service.list({}).items).toHaveLength(0);
    fixture.controls.failListener = true;
    const created = fixture.create();
    expect(created.success).toBe(true);
    expect(fixture.service.list({}).items[0].id).toBe(created.issue.id);
  });
});
