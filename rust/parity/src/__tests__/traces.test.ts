import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareTraces, formatTraceDifferences, groupTrace, mergeTraces, readTraces, type Traces } from '../traces.js';
import { contractHeaders } from '../capture.js';
import { traceGroup } from '../trace-unstable.js';

test('records contract response headers without incidental headers', () => {
  expect(contractHeaders(new Headers({
    'X-Content-Type-Options': 'nosniff',
    'X-Garcon-Executor-Instance': 'fixture-instance',
    'X-Garcon-File-Revision': '7',
    'X-Garcon-File-List-Truncated': 'true',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    'Link': '</canonical>; rel="canonical"',
    'X-Unrelated': 'ignored',
    'Content-Length': '12',
  }))).toEqual({
    'content-length': '12',
    'x-content-type-options': 'nosniff',
    'x-garcon-executor-instance': 'fixture-instance',
    'x-garcon-file-revision': '7',
    'x-garcon-file-list-truncated': 'true',
    'x-robots-tag': 'noindex',
    'referrer-policy': 'no-referrer',
    link: '</canonical>; rel="canonical"',
  });
});

test('orders HTTP and replies separately from arrival within each chat and event type', () => {
  expect(groupTrace([
    { test: 'example', order: 4, stream: 'broadcasts', group: 'chat-1 > changed', value: 'later' },
    { test: 'example', order: 1, stream: 'broadcasts', group: 'chat-1 > changed', value: 'earlier' },
    { test: 'example', order: 3, stream: 'broadcasts', group: 'chat-2 > changed', value: 'other chat' },
    { test: 'example', order: 2, stream: 'http', value: 'response' },
    { test: 'example', order: 0, stream: 'replies', value: 'reply' },
  ])).toEqual({
    example: {
      http: ['response'],
      replies: ['reply'],
      broadcasts: { 'chat-1 > changed': ['earlier', 'later'], 'chat-2 > changed': ['other chat'] },
    },
  });
});

test('matches stable values and wildcards but reports order and shape differences', () => {
  const reports = (token: string, order: string[]): Traces => new Map([['scenario.test.ts', {
    'variable payload': { replies: [{ type: 'result', token }], http: [] },
    'ordered broadcasts': { broadcasts: { group: order } },
  }]]);
  const first = reports('abc123', ['first', 'second']);
  const second = reports('def456', ['second', 'first']);
  const { golden, problems, noise, unstableBroadcasts } = mergeTraces([first, second]);
  expect(noise).toEqual(['scenario.test.ts > variable payload at $.replies[0].token']);
  expect(problems).toHaveLength(0);
  expect(unstableBroadcasts).toHaveLength(1);
  expect(unstableBroadcasts[0]?.difference).toMatchObject({ path: '$.broadcasts.group[0]', kind: 'order' });
  const candidate = reports('def456', ['second', 'first']);
  expect(compareTraces(golden, candidate)).toEqual({ total: 2, problems: [], excludedBroadcasts: 1, excludedTests: 0, excludedPaths: 0 });
  const bad: Traces = new Map([['scenario.test.ts', {
    'variable payload': { http: [], replies: [] },
    'ordered broadcasts': { broadcasts: { group: ['second'], unexpected: ['new'] } },
  }]]);
  const result = compareTraces(golden, bad);
  expect(result.total).toBe(2);
  expect(formatTraceDifferences(result.problems)).toContain('| $.replies | length | 1 |');
  expect(result.problems[0]?.difference.path).toBe('$.broadcasts.unexpected');
});

test('refuses reordered HTTP exchanges instead of excluding them', () => {
  const fixture = (...http: string[]): Traces => new Map([['scenario.test.ts', { test: { http } }]]);
  const { problems, unstableBroadcasts } = mergeTraces([fixture('GET /first', 'GET /second'), fixture('GET /second', 'GET /first')]);
  expect(problems[0]?.difference).toMatchObject({ path: '$.http[0]', kind: 'order' });
  expect(unstableBroadcasts).toEqual([]);
});

test('uses later recordings to detect rare groups and applies only declared exclusions', () => {
  const suite = 'scenario.test.ts';
  const declaredGroup = traceGroup(null, 'startup');
  const rareGroup = traceGroup('chat', 'sometimes');
  const run = (status: number, broadcasts: Record<string, string[]>): Traces => new Map([[suite, {
    stable: { http: [{ status }], broadcasts },
    flaky: { http: [status] },
  }]]);
  const excluded = [{ suite, test: 'flaky', reason: 'test reason' }, { suite, chat: null, type: 'startup', reason: 'group reason' }];
  const { golden, problems, unstableBroadcasts } = mergeTraces([
    run(200, {}), run(200, { [declaredGroup]: ['startup'] }), run(200, { [rareGroup]: ['third run'] }),
  ], excluded);
  expect(problems).toEqual([]);
  expect(unstableBroadcasts[0]?.difference.kind).toBe('extra');
  expect(compareTraces(golden, run(200, { [rareGroup]: ['different'], [declaredGroup]: ['different'] }), [], excluded))
    .toEqual({ total: 1, problems: [], excludedTests: 1, excludedBroadcasts: 2, excludedPaths: 0 });
  expect(compareTraces(golden, run(201, {}), [], excluded).problems[0]?.difference.path).toBe('$.http[0].status');
});

test('excludes one unstable path, not its test, siblings, or the same path in another test', () => {
  const suite = 'scenario.test.ts';
  const row = (activityStatus: string | null, id = 'same') => ({ http: [{ body: { sessions: [{ activityStatus, id }] } }] });
  const run = (activity: string | null, id?: string, otherActivity: string | null = 'complete'): Traces =>
    new Map([[suite, { noisy: row(activity, id), other: row(otherActivity) }]]);
  const path = '$.http[0].body.sessions[0].activityStatus';
  const exclusions = [{ suite, test: 'noisy', path, reason: 'fixture activity race' }];
  expect(mergeTraces([run('complete'), run(null)]).problems[0]?.difference.path).toBe(path);
  const { golden, problems, noise } = mergeTraces([run('complete'), run(null)], exclusions);
  expect(problems).toEqual([]);
  expect(noise).toEqual([]);
  const matched = compareTraces(golden, run(null), [], exclusions);
  expect(matched).toMatchObject({ total: 2, problems: [], excludedTests: 0, excludedPaths: 1 });
  expect(compareTraces(golden, run(null, 'wrong'), [], exclusions).problems[0]?.difference.path)
    .toBe('$.http[0].body.sessions[0].id');
  expect(compareTraces(golden, run(null, 'same', null), [], exclusions).problems[0]).toMatchObject({
    test: 'other', difference: { path },
  });
});

test('the opt-in client writes one named trace with HTTP, replies and attributed broadcasts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parity-trace-fixture-'));
  const repoRoot = resolve(import.meta.dir, '../../../..');
  const suite = 'rust/parity/src/__tests__/fixtures/trace-demo.suite.ts';
  try {
    const run = Bun.spawn([process.execPath, 'test', `./${suite}`], {
      cwd: repoRoot,
      env: { ...process.env, GARCON_TEST_TRACE_DIR: directory },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    expect(await run.exited).toBe(0);
    const traces = await readTraces(directory, 'jsonl');
    expect([...traces.keys()]).toEqual([suite]);
    expect(traces.get(suite)?.['names a top-level test and captures both client transports']).toEqual({
      http: [{
        request: { method: 'POST', path: '/sample?foo=bar' },
        status: 201,
        headers: expect.objectContaining({ 'x-content-type-options': 'nosniff' }),
        requestBody: { kind: 'json', value: { body: 'request' } },
        body: { kind: 'json', value: { echoed: { body: 'request' } } },
      }],
      replies: [expect.objectContaining({ type: 'ws-pong', clientRequestId: '{{uuid}}' })],
      broadcasts: {
        '["1234567890123456","chat-title-updated"]': [expect.objectContaining({ title: 'Synthetic', clientRequestId: 'an-http-command' })],
      },
    });
    expect(traces.get(suite)?.['assigns placeholders in exchange order rather than callback order']).toMatchObject({
      http: [
        { request: { path: '/first' }, body: { value: { chatId: '{{chatId1}}', url: 'http://{{loopback}}:{{port1}}' } } },
        { request: { path: '/second' }, body: { value: { chatId: '{{chatId2}}', url: 'http://{{loopback}}:{{port2}}' } } },
      ],
      broadcasts: { '["{{chatId2}}","changed"]': [{ type: 'changed', chatId: '{{chatId2}}' }] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('names traces under conditional and parameterized describes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parity-trace-fixture-'));
  const repoRoot = resolve(import.meta.dir, '../../../..');
  const suite = 'rust/parity/src/__tests__/fixtures/trace-describe.suite.ts';
  try {
    const run = Bun.spawn([process.execPath, 'test', `./${suite}`], {
      cwd: repoRoot,
      env: { ...process.env, GARCON_TEST_TRACE_DIR: directory },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [code, error] = await Promise.all([run.exited, new Response(run.stderr).text()]);
    expect({ code, error }).toMatchObject({ code: 0 });
    const traces = await readTraces(directory, 'jsonl');
    expect(Object.keys(traces.get(suite) ?? {}).sort()).toEqual([
      'if > same',
      'row first > skipIf > same',
      'row second > skipIf > same',
      'todoIf > same',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
