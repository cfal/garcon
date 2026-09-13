import { describe, expect, test } from 'bun:test';
import type { HttpIssueMutationRequest } from '@garcon/common/issue-commands';
import type { Issue, IssueDetail, IssuePage, IssueWriteResult } from '@garcon/common/issues';
import { main } from '../main.js';
import { createCliOutput } from '../output.js';
import { issueQueryParams, issueSearchParams } from '@garcon/common/issue-query';

const STORE = '22222222-2222-4222-8222-222222222222';
const REQUEST = '11111111-1111-4111-8111-111111111111';
const TS = '2026-01-01T00:00:00.000Z';
const issue: Issue = { id: 'G-1', number: 1, revision: 1, title: 'Synthetic task', description: 'Synthetic body',
  project: 'Release', status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
  createdAt: TS, updatedAt: TS, createdBy: { kind: 'user', username: 'local', principalMode: 'local', declaredChatId: null } };
const result: IssueWriteResult = { success: true, storeId: STORE, collectionRevision: 1, issue };
const page: IssuePage = { storeId: STORE, collectionRevision: 1, items: [], nextBeforeNumber: null };
const detail: IssueDetail = { storeId: STORE, collectionRevision: 1, issue, links: [],
  comments: { storeId: STORE, collectionRevision: 1, items: [], nextBeforeSequence: null } };

function harness(handle: (url: URL, body: unknown) => Response | Promise<Response>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: { url: URL; body: unknown }[] = [];
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-capability');
    const url = new URL(String(input));
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return handle(url, body);
  }, { preconnect() {} }) satisfies typeof fetch;
  const run = (args: string[], extra: { readStdin?: () => Promise<string>; signal?: AbortSignal } = {}) => main(['issue', ...args], {
    fetch: fetcher, output: createCliOutput({ write: (text) => stdout.push(text) }, { write: (text) => stderr.push(text) }),
    discoverRuntime: async () => ({ baseUrl: 'http://localhost:8080', instanceId: 'synthetic-instance',
      localCapability: 'synthetic-capability', workspaceDir: '/workspace' }), ...extra,
  });
  return { run, calls, stdout, stderr };
}

describe('issue CLI execution', () => {
  test('interrupt diagnostics distinguish read, pre-submission and uncertain mutation phases', async () => {
    for (const args of [['list'], ['read', 'G-1'], ['history', 'G-1'], ['create', '--title', 'Synthetic task', '--project', 'Release']]) {
      const interrupt = new AbortController();
      const testCase = harness(() => { interrupt.abort(); throw new Error('Synthetic interruption'); });
      expect(await testCase.run(args, { signal: interrupt.signal })).toBe(130);
      expect(testCase.stderr.join('')).toContain('no issue mutation was submitted');
      expect(testCase.stderr.join('')).not.toContain('printed identity');
    }
    const stdinInterrupt = new AbortController();
    const stdin = harness(() => { throw new Error('No HTTP call expected'); });
    expect(await stdin.run(['comment', 'G-1', '--stdin'], { signal: stdinInterrupt.signal,
      readStdin: async () => { stdinInterrupt.abort(); throw new Error('Synthetic interruption'); } })).toBe(130);
    expect(stdin.calls).toHaveLength(0);
    expect(stdin.stderr.join('')).toContain('no issue mutation was submitted');
    const interrupt = new AbortController();
    const mutation = harness(() => { interrupt.abort(); throw new Error('Synthetic interruption'); });
    expect(await mutation.run(['comment', 'G-1', '--body', 'Synthetic', '--request-id', REQUEST, '--expected-store-id', STORE],
      { signal: interrupt.signal })).toBe(130);
    expect(mutation.stderr.join('')).toContain('the issue save is not confirmed');
    expect(mutation.stderr.join('')).toContain(REQUEST);
  });
  test('resolves default and prints frozen retry identity before the first authenticated POST', async () => {
    const testCase = harness((url, body) => {
      if (url.pathname.endsWith('/bootstrap')) return Response.json({ storeId: STORE, collectionRevision: 0, viewerKey: 'local' });
      if (url.pathname.endsWith('/project-default')) {
        expect(body).toEqual({ directory: '/workspace/linked' });
        return Response.json({ project: '/workspace/base', kind: 'repository' });
      }
      expect(url.pathname).toBe('/api/v1/issues/mutate');
      const request = body as HttpIssueMutationRequest;
      expect(testCase.stderr.join('')).toContain(request.requestId);
      expect(testCase.stderr.join('')).toContain('--expected-store-id');
      expect(testCase.stderr.join('')).toContain("--project $'/workspace/base'");
      expect(testCase.stderr.join('')).toContain('Project (repository)');
      expect(testCase.stdout).toEqual([]);
      expect(request.payload).toMatchObject({ action: 'create', input: { project: '/workspace/base', description: 'Synthetic stdin' } });
      return Response.json(result, { status: 201 });
    });
    expect(await testCase.run(['create', '--title', 'Synthetic task', '--cwd', '/workspace/linked', '--stdin', '--json'],
      { readStdin: async () => 'Synthetic stdin' })).toBe(0);
    expect(JSON.parse(testCase.stdout.join(''))).toEqual(result);
    expect(testCase.calls).toHaveLength(3);
  });

  test('explicit project bypasses default lookup and retries never bootstrap or resolve a moved directory', async () => {
    const testCase = harness((url) => {
      expect(url.pathname).toBe('/api/v1/issues/mutate');
      return Response.json(result);
    });
    expect(await testCase.run(['create', '--title', 'Synthetic task', '--project', 'Release', '--cwd', '/missing',
      '--request-id', REQUEST, '--expected-store-id', STORE, '--json'])).toBe(0);
    expect(testCase.calls).toHaveLength(1);
    expect(testCase.stderr.join('')).toContain('Project (explicit)');
    expect(JSON.parse(testCase.stdout.join(''))).toEqual(result);
  });

  test('read routes encode typed filters, projection and continuation without bootstrap', async () => {
    const testCase = harness((url) => Response.json(url.pathname.endsWith('/detail') ? detail
      : url.pathname.endsWith('/history') ? { storeId: STORE, collectionRevision: 1, items: [], nextBeforeSequence: null } : page));
    expect(await testCase.run(['list', '--assignee', 'user:name:team', '--query', '%_&', '--before-number', '9', '--expected-collection-revision', '1', '--json'])).toBe(0);
    expect(testCase.calls[0]?.url.searchParams.get('assignee')).toBe('user:name:team');
    expect(testCase.calls[0]?.url.searchParams.get('query')).toBe('%_&');
    expect(await testCase.run(['read', 'G-1', '--include-description', 'false', '--comment-limit', '1', '--before-comment-sequence', '2', '--expected-collection-revision', '1'])).toBe(0);
    expect(testCase.calls[1]?.url.searchParams.get('beforeCommentSequence')).toBe('2');
    expect(await testCase.run(['history', 'G-1', '--before-sequence', '2'])).toBe(0);
    expect(testCase.calls[2]?.url.searchParams.has('expectedCollectionRevision')).toBe(false);
    expect(testCase.stderr).toEqual([]);
  });

  test('encodes assignees without conflating colons, Unicode or unassigned', () => {
    for (const assignee of ['unassigned', { kind: 'user', username: 'é:team' }, { kind: 'chat', chatId: '1000000000000001' }] as const) {
      expect(issueQueryParams(issueSearchParams({ assignee }))).toEqual({ assignee });
    }
  });

  test('never automatically retries an ambiguous write and exposes no false success', async () => {
    const testCase = harness(() => { throw new Error('Synthetic lost response'); });
    expect(await testCase.run(['comment', 'G-1', '--body', 'Synthetic', '--request-id', REQUEST, '--expected-store-id', STORE])).toBe(3);
    expect(testCase.calls).toHaveLength(1);
    expect(testCase.stdout).toEqual([]);
    expect(testCase.stderr.join('')).toContain('Save not confirmed');
    expect(testCase.stderr.join('')).toContain(REQUEST);
  });

  test('rejects oversized encoded requests and invalid stdin without submitting', async () => {
    const testCase = harness(() => { throw new Error('No request expected'); });
    const flags = ['--request-id', REQUEST, '--expected-store-id', STORE];
    expect(await testCase.run(['comment', 'G-1', '--stdin', ...flags], { readStdin: async () => '\0'.repeat(12000) })).toBe(2);
    expect(await testCase.run(['comment', 'G-1', '--stdin', ...flags], { readStdin: async () => '\ud800' })).toBe(2);
    expect(testCase.calls).toHaveLength(0);
    expect(testCase.stdout).toEqual([]);
  });

  test('keeps terminal errors safe and typed domain failures nonzero', async () => {
    const testCase = harness(() => Response.json({ success: false, error: 'Synthetic \x1b]0;inject\x07\u202e',
      errorCode: 'ISSUE_REVISION_CONFLICT', retryable: false }, { status: 409 }));
    expect(await testCase.run(['claim', 'G-1', '--expected-revision', '1', '--request-id', REQUEST, '--expected-store-id', STORE])).toBe(3);
    expect(testCase.stderr.join('')).toContain('ISSUE_REVISION_CONFLICT');
    expect(testCase.stderr.join('')).not.toMatch(/[\x1b\x07\u202e]/u);
    expect(testCase.stdout).toEqual([]);
    expect(await testCase.run(['list', '--bad\x1bflag'])).toBe(2);
    expect(testCase.stderr.join('')).not.toContain('\x1b');
  });

  test('rejects mismatched store or target response rather than confirming a write', async () => {
    const testCase = harness(() => Response.json({ ...result, storeId: REQUEST }));
    expect(await testCase.run(['claim', 'G-1', '--expected-revision', '1', '--request-id', REQUEST, '--expected-store-id', STORE])).toBe(3);
    expect(testCase.stdout).toEqual([]);
    expect(testCase.stderr.join('')).toContain('Save not confirmed');
  });
});
