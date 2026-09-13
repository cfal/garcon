import { afterEach, describe, expect, test } from 'bun:test';
import { IssueCommandController } from '../command-controller.js';
import { parseGarconIssueCommand } from '../../../common/garcon-issue-command.js';
import { parseGarconIssueResult } from '../../../common/garcon-issue-result.js';
import { issueBytes } from '../../../common/issue-validation.js';
import { ISSUE_LIMITS } from '../../../common/issues.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import { CHAT_ID, VIEW_ID, issueFixture } from './fixture.js';

const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.controller.shutdown(); f.cleanup(); } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const source = { chatId: CHAT_ID, viewId: VIEW_ID, requestOrdinal: 1, runId: 'synthetic-run', at: '2026-01-01T00:00:00.000Z' };
const create = '<garcon-issue-create ref="create">{"title":"Synthetic issue"}</garcon-issue-create>';

function fixture(resolveProject) {
  const f = issueFixture();
  const notices = [];
  const deliveries = [];
  const waiters = [];
  const current = { viewId: VIEW_ID, directory: '/synthetic', failNotice: false, failDelivery: false, replacedStore: false };
  const lock = new KeyedPromiseLock();
  const controller = new IssueCommandController({
    issues: { get service() { return current.replacedStore ? { storeId: '44444444-4444-4444-8444-444444444444' } : f.service; } },
    registry: { getChat: (id) => f.chats.has(id) ? { projectPath: current.directory } : null },
    notices: {
      existingCurrentView: () => ({ viewId: current.viewId }),
      appendNotice(_chatId, _viewId, notice) {
        if (current.failNotice) throw new Error('Synthetic notice failure');
        notices.push(notice);
      },
    },
    execution: { async deliverServerControlInput(_chatId, input) {
      if (current.failDelivery) throw new Error('Synthetic delivery failure');
      await lock.runExclusive(`chat:${CHAT_ID}`, async () => {});
      const parsed = parseGarconIssueResult(input.content);
      expect(parsed).not.toBeNull();
      deliveries.push({ input, result: parsed });
      waiters.shift()?.resolve(parsed);
      return { status: 'queued' };
    } },
    chatMutationLock: lock, isEnabled: () => f.controls.enabled,
    resolveProject: resolveProject ?? (async () => ({ project: 'Resolved project', kind: 'repository' })),
  });
  const send = (xml, requestOrdinal = 1) => {
    const completed = Promise.withResolvers();
    waiters.push(completed);
    const command = parseGarconIssueCommand(xml);
    expect(command).not.toBeNull();
    controller.request({ ...source, requestOrdinal }, command);
    return completed.promise;
  };
  const complete = { ...f, controller, current, lock, notices, deliveries, send,
    get service() { return f.service; } };
  fixtures.push(complete);
  return complete;
}

describe('issue command controller', () => {
  test('commits attributed writes, compact notices and result delivery outside the source lock', async () => {
    const f = fixture();
    const result = await f.send(create);
    expect(result).toMatchObject({ command: 'create', ref: 'create', issueId: 'G-1', status: 'ok', requestOrdinal: 1 });
    const issue = f.service.read({ issueId: 'G-1' }, { kind: 'chat', chatId: CHAT_ID }).issue;
    expect(issue.project).toBe('Resolved project');
    expect(issue.createdBy).toEqual({ kind: 'chat', chatId: CHAT_ID, provenance: 'observed' });
    expect(f.service.history({ issueId: 'G-1' }).items[0].source)
      .toEqual({ chatId: CHAT_ID, transcriptViewId: VIEW_ID, ordinal: 1 });
    expect(f.notices).toHaveLength(1);
    expect(JSON.stringify(f.notices)).not.toContain('Synthetic issue');
    expect(f.deliveries[0].input.receipt).toBeNull();
  });

  test('returns the original committed result before probing a moved or missing project', async () => {
    let probes = 0;
    const f = fixture(async () => { probes++; if (probes > 1) throw new Error('Unavailable'); return { project: 'Original', kind: 'repository' }; });
    const first = await f.send(create);
    f.write({ action: 'update', issueId: 'G-1', expectedRevision: 1, patch: { title: 'Later title' } });
    f.current.directory = '/unavailable';
    f.reopen();
    const retry = await f.send(create, 7);
    expect(retry.data).toEqual(first.data);
    expect(retry.requestOrdinal).toBe(7);
    expect(probes).toBe(1);
    expect(f.service.list({}).items).toHaveLength(1);
    const conflict = await f.send(create.replace('Synthetic issue', 'Different issue'), 8);
    expect(conflict.errorCode).toBe('ISSUE_REQUEST_CONFLICT');
  });

  test.each(['changed-path', 'failed-probe'])('rechecks a concurrent committed duplicate before %s', async (failure) => {
    const held = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let probes = 0;
    const f = fixture(async () => {
      probes++;
      if (probes === 1) { entered.resolve(); return held.promise; }
      return { project: 'Winner', kind: 'repository' };
    });
    const first = f.send(create);
    await entered.promise;
    await f.lock.runExclusive(`chat:${CHAT_ID}`, async () => {});
    const second = f.send(create, 2);
    const winner = await first;
    expect(winner.requestOrdinal).toBe(2);
    if (failure === 'changed-path') { f.current.directory = '/moved'; held.resolve({ project: 'Obsolete', kind: 'folder' }); }
    else held.reject(new Error('Synthetic failed probe'));
    const duplicate = await second;
    expect(duplicate.requestOrdinal).toBe(1);
    expect(duplicate.data).toEqual(winner.data);
    expect(f.service.list({}).items).toHaveLength(1);
  });

  test('rejects changed context for new work without committing an issue', async () => {
    const held = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const f = fixture(async () => { entered.resolve(); return held.promise; });
    const pending = f.send(create);
    await entered.promise;
    f.current.directory = '/moved';
    held.resolve({ project: 'Obsolete', kind: 'folder' });
    expect((await pending).errorCode).toBe('ISSUE_SOURCE_UNAVAILABLE');
    expect(f.service.list({}).items).toEqual([]);
  });

  test.each(['view', 'delete', 'cancel', 'shutdown'])('fences %s while a default is held', async (fence) => {
    const held = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const f = fixture(async () => { entered.resolve(); return held.promise; });
    f.controller.request(source, parseGarconIssueCommand(create));
    await entered.promise;
    if (fence === 'view') f.current.viewId = '33333333-3333-4333-8333-333333333333';
    if (fence === 'delete') f.chats.delete(CHAT_ID);
    if (fence === 'cancel') f.controller.discardSource(CHAT_ID);
    if (fence === 'shutdown') f.controller.shutdown();
    held.resolve({ project: 'Obsolete', kind: 'folder' });
    await tick();
    expect(f.service.list({}).items).toEqual([]);
    expect(f.deliveries).toEqual([]);
  });

  test.each(['settings', 'store'])('revalidates %s after the probe even for a committed duplicate', async (fence) => {
    const held = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let probes = 0;
    const f = fixture(async () => {
      if (++probes === 1) { entered.resolve(); return held.promise; }
      return { project: 'Winner', kind: 'repository' };
    });
    const first = f.send(create);
    await entered.promise;
    const second = f.send(create, 2);
    expect((await first).status).toBe('ok');
    if (fence === 'settings') f.controls.enabled = false;
    else f.current.replacedStore = true;
    held.resolve({ project: 'Old', kind: 'folder' });
    expect((await second).errorCode).toBe(fence === 'settings' ? 'ISSUE_COMMANDS_DISABLED' : 'ISSUE_STORE_CHANGED');
  });

  test('gates reads and writes, but a notice or invalidation failure does not hide committed success', async () => {
    const f = fixture();
    f.controls.enabled = false;
    expect((await f.send(create)).errorCode).toBe('ISSUE_COMMANDS_DISABLED');
    expect((await f.send('<garcon-issue-list />')).errorCode).toBe('ISSUE_COMMANDS_DISABLED');
    f.controls.enabled = true;
    f.current.failNotice = true;
    f.controls.failListener = true;
    expect((await f.send(create)).status).toBe('ok');
    expect(f.service.list({}).items).toHaveLength(1);
  });

  test('lost delivery and postcommit cancellation preserve durable retry results', async () => {
    const f = fixture();
    f.current.failDelivery = true;
    f.controller.request(source, parseGarconIssueCommand(create));
    await tick();
    f.controller.discardSource(CHAT_ID);
    expect(f.service.list({}).items).toHaveLength(1);
    f.current.failDelivery = false;
    expect((await f.send(create, 3)).status).toBe('ok');
    expect(f.service.history({ issueId: 'G-1' }).items).toHaveLength(1);
  });

  test('byte-packs lists and mutable comment continuations without skipping overflow records', async () => {
    const f = fixture();
    for (let index = 0; index < 15; index++) f.create({ project: '&'.repeat(3000), title: `Synthetic ${index}` });
    const numbers = [];
    let query = { limit: 100 };
    do {
      const response = await f.send(`<garcon-issue-list>${JSON.stringify(query)}</garcon-issue-list>`);
      expect(response.status).toBe('ok');
      expect(issueBytes(f.deliveries.at(-1).input.content)).toBeLessThanOrEqual(ISSUE_LIMITS.markupBytes);
      numbers.push(...response.data.items.map((issue) => issue.number));
      query = { limit: 100, beforeNumber: response.data.nextBeforeNumber, expectedCollectionRevision: response.data.collectionRevision };
    } while (query.beforeNumber !== null);
    expect(numbers).toEqual(Array.from({ length: 15 }, (_, index) => 15 - index));
    for (let index = 0; index < 5; index++) f.write({ action: 'comment', issueId: 'G-1', body: `Comment ${index}` });
    const first = await f.send('<garcon-issue-read issue-id="G-1">{"commentLimit":2}</garcon-issue-read>');
    const next = await f.send(`<garcon-issue-read issue-id="G-1">{"commentLimit":2,"beforeCommentSequence":${first.data.comments.nextBeforeSequence},"expectedCollectionRevision":${first.data.collectionRevision}}</garcon-issue-read>`);
    expect(first.data.comments.items.map((comment) => comment.sequence)).toEqual([4, 5]);
    expect(next.data.comments.items.map((comment) => comment.sequence)).toEqual([2, 3]);
    f.write({ action: 'comment', issueId: 'G-1', body: 'Later' });
    const stale = await f.send(`<garcon-issue-read issue-id="G-1">{"commentLimit":2,"beforeCommentSequence":2,"expectedCollectionRevision":${first.data.collectionRevision}}</garcon-issue-read>`);
    expect(stale.errorCode).toBe('ISSUE_COLLECTION_CHANGED');
  });

  test('returns typed single-record overflow with a metadata-only escape hatch', async () => {
    const f = fixture();
    f.create();
    f.write({ action: 'comment', issueId: 'G-1', body: '<'.repeat(ISSUE_LIMITS.bodyBytes) });
    expect((await f.send('<garcon-issue-read issue-id="G-1" />')).errorCode).toBe('ISSUE_RESULT_TOO_LARGE');
    const metadata = await f.send('<garcon-issue-read issue-id="G-1">{"includeDescription":false,"commentLimit":0}</garcon-issue-read>');
    expect(metadata.status).toBe('ok');
    expect(metadata.data.issue.description).toBeNull();
    expect(metadata.data.comments.items).toEqual([]);
    expect((await f.send('<garcon-issue-history issue-id="G-1" />')).errorCode).toBe('ISSUE_RESULT_TOO_LARGE');
  });
});
