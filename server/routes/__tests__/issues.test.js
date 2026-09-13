import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseIssueBootstrap, parseIssueCommentsPage, parseIssueCounts, parseIssueDetail,
  parseIssueFacets, parseIssueHistoryPage, parseIssuePage } from '../../../common/issue-responses.js';
import { parseIssueWriteResult } from '../../../common/issue-records.js';
import { ISSUE_LIMITS } from '../../../common/issues.js';
import { CHAT_ID, issueFixture, principal } from '../../issues/__tests__/fixture.js';
import { ISSUE_ERROR_POLICY, IssueDomainError } from '../../issues/errors.js';
import { issueErrorResponse } from '../../issues/http.js';
import { initializeIssues } from '../../issues/setup.js';
import { jsonErrorFromUnknown } from '../../lib/http-error.js';
import { wrapRoutes } from '../../lib/http-route.js';
import { createIssueRoutes } from '../issues.js';

describe('authenticated Issues routes', () => {
  let fixture;
  let routes;
  let defaultCalls;
  beforeEach(() => {
    fixture = issueFixture();
    defaultCalls = [];
    routes = createIssueRoutes(fixture, async (directory) => {
      defaultCalls.push(directory);
      return { project: '/synthetic/shared', kind: 'repository' };
    });
  });
  afterEach(() => fixture.cleanup());

  async function call(path = '', body, options = {}) {
    const method = body === undefined ? 'GET' : 'POST';
    const url = new URL(`http://localhost/api/v1/issues${path}`);
    const request = new Request(url, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      ...options.request });
    const response = await routes[url.pathname][method](request, url, undefined,
      { principal: Object.hasOwn(options, 'principal') ? options.principal : principal });
    expect(response.headers.get('cache-control')).toBe('no-store');
    return { response, body: await response.json() };
  }
  const mutate = (payload, overrides) => call('/mutate', fixture.request(payload, overrides));

  test('authenticates every route before accessing storage or request bodies', async () => {
    for (const [path, handlers] of Object.entries(routes)) {
      const method = Object.keys(handlers)[0];
      const result = await call(path.slice('/api/v1/issues'.length), method === 'POST' ? {} : undefined, { principal: null });
      expect(result.response.status).toBe(401);
      expect(result.body.errorCode).toBe('ISSUE_UNAUTHORIZED');
    }
    expect(fixture.service.list({}).items).toEqual([]);
  });

  test('keeps no-store on production-wrapped authentication failures for every issue endpoint', async () => {
    const wrapped = wrapRoutes(routes);
    for (const [path, methods] of Object.entries(wrapped)) {
      for (const [method, handler] of Object.entries(methods)) {
        for (const authorization of [null, 'Bearer synthetic-invalid-token']) {
          const response = await handler(new Request(`http://localhost${path}`, { method,
            headers: authorization ? { authorization } : {} }));
          expect(response.status).toBe(401);
          expect(response.headers.get('cache-control')).toBe('no-store');
        }
      }
    }
    expect(fixture.service.list({}).items).toEqual([]);
  });

  test('round-trips typed reads and principal-attributed creation without probing an explicit project', async () => {
    const bootstrap = parseIssueBootstrap((await call('/bootstrap')).body);
    expect(bootstrap.storeId).toBe(fixture.service.storeId);
    const created = await mutate({ action: 'create', input: { title: 'Synthetic title', project: 'Arbitrary <project>' } });
    expect(created.response.status).toBe(201);
    const result = parseIssueWriteResult(created.body);
    expect(result.issue.createdBy).toEqual({ kind: 'user', username: 'local', principalMode: 'local', declaredChatId: null });
    expect(defaultCalls).toEqual([]);
    const comment = await mutate({ action: 'comment', issueId: result.issue.id, body: 'Synthetic comment' });
    expect(comment.response.status).toBe(200);
    const detail = parseIssueDetail((await call(`/detail?issueId=${result.issue.id}`)).body);
    expect(detail.comments.items[0].canEdit).toBe(true);
    expect(parseIssuePage((await call('')).body).items[0].commentCount).toBe(1);
    expect(parseIssueCounts((await call('/counts')).body).counts.open).toBe(1);
    expect(parseIssueFacets((await call('/facets?field=project&prefix=Arbitrary')).body).values).toEqual(['Arbitrary <project>']);
    expect(parseIssueCommentsPage((await call(`/comments?issueId=${result.issue.id}`)).body).items).toHaveLength(1);
    expect(parseIssueHistoryPage((await call(`/history?issueId=${result.issue.id}`)).body).items).toHaveLength(2);
    expect((await call('/project-default', { directory: '/synthetic/worktree' })).body)
      .toEqual({ project: '/synthetic/shared', kind: 'repository' });
    expect(defaultCalls).toEqual(['/synthetic/worktree']);
  });

  test('keeps observed authority separate from declared chat provenance', async () => {
    const created = fixture.create();
    const comment = fixture.markup({ action: 'comment', issueId: created.issue.id, body: 'Observed chat comment' }, 'comment');
    const edited = await mutate({ action: 'comment-edit', issueId: created.issue.id,
      commentId: comment.comment.id, expectedRevision: 1, body: 'Forged edit' }, { fromChatId: CHAT_ID });
    expect(edited.response.status).toBe(403);
    expect(edited.body.errorCode).toBe('ISSUE_FORBIDDEN');
    const spoofed = await call('/mutate', { ...fixture.request({ action: 'comment', issueId: created.issue.id, body: 'Text' }), actor: { kind: 'chat', chatId: CHAT_ID } });
    expect(spoofed.response.status).toBe(400);
    const remote = { mode: 'authenticated', key: 'synthetic-user', username: 'synthetic-user', expiresAtMs: Date.now() + 60_000 };
    const wrote = await call('/mutate', fixture.request({ action: 'comment', issueId: created.issue.id, body: 'Human comment' }, { fromChatId: CHAT_ID }), { principal: remote });
    expect(wrote.body.comment.author).toEqual({ kind: 'user', username: remote.username, principalMode: 'authenticated', declaredChatId: CHAT_ID });
  });

  test('returns the original create after restart and declared-chat deletion, while current settings still gate it', async () => {
    const request = fixture.request({ action: 'create', input: { title: 'Synthetic', project: 'Frozen' } }, { fromChatId: CHAT_ID });
    const first = await call('/mutate', request);
    fixture.chats.delete(CHAT_ID);
    fixture.reopen();
    expect((await call('/mutate', request)).body).toEqual(first.body);
    expect((await call('/mutate', request)).response.status).toBe(201);
    fixture.controls.enabled = false;
    expect((await call('/mutate', request)).body.errorCode).toBe('ISSUE_COMMANDS_DISABLED');
    fixture.controls.enabled = true;
    expect((await call('/mutate', request)).body).toEqual(first.body);
    expect(fixture.service.list({}).items).toHaveLength(1);
  });

  test('rejects an old store identity even if the replacement contains the same issue and revision', async () => {
    const first = fixture.create();
    const request = fixture.request({ action: 'update', issueId: first.issue.id, expectedRevision: 1, patch: { title: 'Stale request' } });
    fixture.service.close();
    renameSync(join(fixture.directory, 'issues.sqlite'), join(fixture.directory, 'issues.saved.sqlite'));
    fixture.reopen();
    const replacement = fixture.create();
    expect(replacement.issue.id).toBe(first.issue.id);
    expect(replacement.issue.revision).toBe(first.issue.revision);
    expect((await call('/mutate', request)).body.errorCode).toBe('ISSUE_STORE_CHANGED');
    expect(fixture.service.read({ issueId: replacement.issue.id }, { kind: 'principal', mode: 'local', key: 'local' }).issue.title)
      .toBe('Synthetic issue');
  });

  test('returns conflict snapshots and typed policies without raw storage errors', async () => {
    const first = fixture.create();
    const conflict = await mutate({ action: 'update', issueId: first.issue.id, expectedRevision: 9, patch: { title: 'Stale' } });
    expect(conflict.body.currentIssue).toEqual(first.issue);
    for (const [code, policy] of Object.entries(ISSUE_ERROR_POLICY)) {
      const error = new IssueDomainError(code, 'Synthetic domain error');
      for (const response of [issueErrorResponse(error), jsonErrorFromUnknown(error)]) {
        expect(response.status).toBe(policy.status);
        expect(await response.json()).toMatchObject({ errorCode: code, retryable: policy.retryable });
      }
    }
    const unknown = issueErrorResponse(new Error('PRIVATE DATABASE PATH'));
    expect(await unknown.text()).not.toContain('PRIVATE');
  });

  test('rejects duplicate/unknown query fields, invalid body bytes and over-budget encoded bodies', async () => {
    for (const path of ['?limit=1&limit=2', '?beforeNumber=2', '/counts?limit=1', '/bootstrap?extra=1', '/history?issueId=G-1&expectedCollectionRevision=0']) {
      expect((await call(path)).response.status).toBe(400);
    }
    const oversized = await mutate({ action: 'create', input: { title: 'Synthetic', project: 'Frozen', description: '\n'.repeat(48 * 1024) } });
    expect(oversized.body.errorCode).toBe('ISSUE_REQUEST_TOO_LARGE');
    for (const body of ['{', new Uint8Array([0xff])]) {
      expect((await call('/mutate', {}, { request: { body } })).body.errorCode).toBe('ISSUE_VALIDATION_FAILED');
    }
    expect(fixture.service.list({}).items).toEqual([]);
  });

  test('packs a requested 100 escape-heavy summaries into legal pages without skipped records', async () => {
    const labels = Array.from({ length: 20 }, (_, index) => `${index}${'𐍈'.repeat(62)}`);
    for (let index = 0; index < 100; index++) fixture.create({ title: '𐍈'.repeat(240), project: '"'.repeat(4096), labels });
    let next;
    const numbers = [];
    do {
      const path = next ? `?limit=100&beforeNumber=${next}&expectedCollectionRevision=100` : '?limit=100';
      const result = await call(path);
      expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(ISSUE_LIMITS.httpBytes);
      const page = parseIssuePage(result.body);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThan(100);
      numbers.push(...page.items.map((item) => item.number));
      next = page.nextBeforeNumber;
    } while (next);
    expect(numbers).toEqual(Array.from({ length: 100 }, (_, index) => 100 - index));
  });

  test('bounds streamed bodies without trusting Content-Length and cancels excess input', async () => {
    let canceled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(ISSUE_LIMITS.requestBytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { canceled = true; },
    });
    const result = await call('/mutate', {}, { request: { body, headers: { 'content-length': '1' } } });
    expect(result.body.errorCode).toBe('ISSUE_REQUEST_TOO_LARGE');
    expect(canceled).toBe(true);
    expect(fixture.service.list({}).items).toEqual([]);
  });

  test('decodes UTF-8 across streamed chunk boundaries before validating JSON', async () => {
    const request = fixture.request({ action: 'create', input: { title: 'Synthetic 𐍈', project: 'Frozen' } });
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    const body = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const result = await call('/mutate', {}, { request: { body } });
    expect(result.response.status).toBe(201);
    expect(result.body.issue.title).toBe('Synthetic 𐍈');
  });

  test('keeps immutable history continuation valid after newer events append', async () => {
    const created = fixture.create();
    for (let index = 0; index < 4; index++) fixture.write({ action: 'comment', issueId: created.issue.id, body: `Comment ${index}` });
    const first = parseIssueHistoryPage((await call(`/history?issueId=${created.issue.id}&limit=2`)).body);
    fixture.write({ action: 'comment', issueId: created.issue.id, body: 'Newer comment' });
    const second = parseIssueHistoryPage((await call(`/history?issueId=${created.issue.id}&limit=100&beforeSequence=${first.nextBeforeSequence}`)).body);
    expect([...second.items, ...first.items].map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  test('an unavailable store returns an error rather than an empty catalog', async () => {
    fixture.service.close();
    const runtime = initializeIssues(join(fixture.directory, 'missing'), { chatExists: () => false, commandsEnabled: () => true });
    routes = createIssueRoutes(runtime);
    expect((await call('')).body.errorCode).toBe('ISSUE_STORAGE_UNAVAILABLE');
    runtime.close();
  });
});
