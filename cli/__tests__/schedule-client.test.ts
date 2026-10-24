import { expect, mock, test } from 'bun:test';
import { GarconClient } from '../garcon-client.js';
import { main } from '../main.js';
import { CLI_SERVER_INSTANCE_HEADER } from '@garcon/common/server-runtime';
import { scheduleId, scheduleChatId, scheduleDefinition, newChatDefinition, schedulePrompt, scheduleSnapshot } from './schedule-fixtures.js';

const connection = { baseUrl: 'http://127.0.0.1:1', instanceId: 'synthetic-controller', endpointInstanceId: 'synthetic-endpoint',
  defaultExecutorId: 'local', workspaceName: null, localCapability: 'synthetic-capability' };

test('schedule HTTP methods preserve typed bodies, exact paths and controller fencing', async () => {
  const calls: { method: string; pathname: string; body: unknown }[] = [];
  const fetcher = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get(CLI_SERVER_INSTANCE_HEADER)).toBe(connection.instanceId);
    calls.push({ method: init?.method ?? 'GET', pathname: new URL(String(url)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(init?.method === 'GET' ? scheduleSnapshot : {
      success: true, snapshot: scheduleSnapshot, scheduledPrompt: schedulePrompt,
    });
  }, { preconnect() {} }) satisfies typeof fetch;
  const client = new GarconClient({ ...connection, fetch: fetcher });
  await client.getScheduledPrompts();
  await client.createScheduledPrompt({ expectedRevision: 0, scheduledPrompt: newChatDefinition });
  await client.updateScheduledPrompt({ expectedRevision: 0, id: scheduleId, scheduledPrompt: scheduleDefinition });
  await client.setScheduledPromptEnabled({ expectedRevision: 0, id: scheduleId, enabled: false });
  await client.deleteScheduledPrompt({ expectedRevision: 0, id: scheduleId });
  expect(calls.map((entry) => `${entry.method} ${entry.pathname}`)).toEqual([
    'GET /api/v1/scheduled-prompts', 'POST /api/v1/scheduled-prompts', 'PUT /api/v1/scheduled-prompts',
    'PUT /api/v1/scheduled-prompts/enabled', 'DELETE /api/v1/scheduled-prompts',
  ]);
  expect(calls[1]?.body).toEqual({ expectedRevision: 0, scheduledPrompt: newChatDefinition });
  expect(calls[4]?.body).toEqual({ expectedRevision: 0, id: scheduleId });
});

test.each([
  {}, { success: false, snapshot: scheduleSnapshot, scheduledPrompt: schedulePrompt },
  { success: true, snapshot: scheduleSnapshot },
  { success: true, snapshot: { ...scheduleSnapshot, prompts: [] }, scheduledPrompt: schedulePrompt },
  { success: true, snapshot: scheduleSnapshot, scheduledPrompt: { ...schedulePrompt, prompt: 'Wrong record' } },
  { success: true, snapshot: { ...scheduleSnapshot, runLog: ['invalid'] }, scheduledPrompt: schedulePrompt },
  { success: true, snapshot: scheduleSnapshot, scheduledPrompt: { ...schedulePrompt, enabled: undefined } },
])('malformed creation replies never become success or automatic retries: %j', async (body) => {
  const request = mock(async () => Response.json(body));
  const fetcher = Object.assign(request, { preconnect() {} }) satisfies typeof fetch;
  const client = new GarconClient({ ...connection, fetch: fetcher });
  await expect(client.createScheduledPrompt({ expectedRevision: 0, scheduledPrompt: scheduleDefinition })).rejects.toThrow('outcome is unknown');
  expect(request).toHaveBeenCalledTimes(1);
});

test.each([400, 409, 500, 503])('mutation HTTP %i preserves definite rejection versus uncertainty', async (status) => {
  const request = mock(async () => Response.json({ error: 'Synthetic failure', errorCode: 'SCHEDULED_PROMPT_REVISION_CONFLICT', retryable: true }, { status }));
  const fetcher = Object.assign(request, { preconnect() {} }) satisfies typeof fetch;
  const client = new GarconClient({ ...connection, fetch: fetcher });
  await expect(client.deleteScheduledPrompt({ expectedRevision: 1, id: scheduleId }))
    .rejects.toThrow(status < 500 ? 'Synthetic failure' : 'outcome is unknown');
  expect(request).toHaveBeenCalledTimes(1);
});

test('main validates stdin before discovery and keeps machine output clean', async () => {
  const stdout: string[] = [], stderr: string[] = [];
  const output = { result: (text: string) => { stdout.push(text); }, diagnostic: (text: string) => { stderr.push(text); } };
  const discover = mock(async () => ({ ...connection, configDir: '/synthetic', runtime: 'controller' as const }));
  const fetcher = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ revision: 0, prompts: [], runLog: [] });
    expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 0, scheduledPrompt: scheduleDefinition });
    return Response.json({ success: true, snapshot: scheduleSnapshot, scheduledPrompt: schedulePrompt });
  }, { preconnect() {} }) satisfies typeof fetch;
  const args = ['schedule', 'create', '--definition', '-', '--json'];
  expect(await main(args, { output, discoverRuntime: discover, readStdin: async () => '{}', fetch: fetcher })).toBe(2);
  expect(discover).not.toHaveBeenCalled();
  stderr.length = 0;
  expect(await main(args, { output, discoverRuntime: discover, readStdin: async () => JSON.stringify(scheduleDefinition), fetch: fetcher })).toBe(0);
  expect(stdout).toHaveLength(1);
  expect(JSON.parse(stdout[0]!)).toEqual({ revision: 1, scheduledPrompt: schedulePrompt });
  expect(stderr).toEqual([]);
});

test('main distinguishes interruption before submission from possible mutation', async () => {
  for (const duringSubmission of [false, true]) {
    const abort = new AbortController();
    const stderr: string[] = [];
    const fetcher = Object.assign(async () => { abort.abort(new Error('Synthetic interruption')); throw abort.signal.reason; }, { preconnect() {} }) satisfies typeof fetch;
    if (!duringSubmission) abort.abort(new Error('Synthetic interruption'));
    const exit = await main(['schedule', 'delete', scheduleId, '--expected-revision', '0'], {
      signal: abort.signal, fetch: fetcher,
      discoverRuntime: async () => ({ ...connection, configDir: '/synthetic', runtime: 'controller' as const }),
      output: { result() { throw new Error('Unexpected success'); }, diagnostic(text) { stderr.push(text); } },
    });
    expect(exit).toBe(130);
    expect(stderr.join('\n')).toContain(duringSubmission ? 'may have committed' : 'no schedule mutation was submitted');
  }
});

test('missing live enablement is an unknown mutation outcome, never inferred success', async () => {
  const stdout: string[] = [], stderr: string[] = [];
  const request = mock(async () => Response.json({ success: true,
    snapshot: { ...scheduleSnapshot, prompts: [{ ...schedulePrompt, enabled: undefined }] },
  }));
  const fetcher = Object.assign(request, { preconnect() {} }) satisfies typeof fetch;
  const exit = await main(['schedule', 'enable', scheduleId, '--expected-revision', '0', '--json'], {
    fetch: fetcher,
    discoverRuntime: async () => ({ ...connection, configDir: '/synthetic', runtime: 'controller' as const }),
    output: { result(text) { stdout.push(text); }, diagnostic(text) { stderr.push(text); } },
  });
  expect(exit).toBe(3);
  expect(stdout).toEqual([]);
  expect(stderr.join('\n')).toContain('outcome is unknown');
  expect(request).toHaveBeenCalledTimes(1);
});

test.each([[404, 'SESSION_NOT_FOUND'], [422, 'UNSUPPORTED_AGENT'], [400, 'SCHEDULED_PROMPT_VALIDATION_FAILED']] as const)(
  'schedule domain rejection %i %s exits 3 without retry', async (status, errorCode) => {
    const stdout: string[] = [], stderr: string[] = [];
    const request = mock(async () => Response.json({ error: 'Synthetic domain rejection', errorCode, retryable: false }, { status }));
    const fetcher = Object.assign(request, { preconnect() {} }) satisfies typeof fetch;
    const exit = await main(['schedule', 'create', '--definition', JSON.stringify(scheduleDefinition), '--expected-revision', '0', '--json'], {
      fetch: fetcher,
      discoverRuntime: async () => ({ ...connection, configDir: '/synthetic', runtime: 'controller' as const }),
      output: { result(text) { stdout.push(text); }, diagnostic(text) { stderr.push(text); } },
    });
    expect(exit).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain(errorCode);
    expect(stderr.join('\n')).not.toContain('outcome is unknown');
    expect(request).toHaveBeenCalledTimes(1);
  },
);

test.each(['create', 'update'] as const)('offline target rejection remains actionable for schedule %s', async (action) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const request = mock(async () => Response.json({
    error: 'Executor is unavailable', errorCode: 'EXECUTOR_UNAVAILABLE', retryable: true,
  }, { status: 503 }));
  const fetcher = Object.assign(request, { preconnect() {} }) satisfies typeof fetch;
  const args = ['schedule', action];
  if (action === 'update') args.push(scheduleId);
  args.push('--definition', JSON.stringify(newChatDefinition), '--expected-revision', '0', '--json');
  const exit = await main(args, {
    fetch: fetcher,
    discoverRuntime: async () => ({ ...connection, configDir: '/synthetic', runtime: 'controller' as const }),
    output: { result(text) { stdout.push(text); }, diagnostic(text) { stderr.push(text); } },
  });
  expect(exit).toBe(3);
  expect(stdout).toEqual([]);
  expect(stderr.join('\n')).toContain('EXECUTOR_UNAVAILABLE');
  expect(stderr.join('\n')).not.toContain('outcome is unknown');
  expect(request).toHaveBeenCalledTimes(1);
});

test('schedule readiness classification does not broaden other mutation rejections', async () => {
  const request = mock(async () => Response.json({
    error: 'Executor is unavailable', errorCode: 'EXECUTOR_UNAVAILABLE', retryable: true,
  }, { status: 503 }));
  const fetcher = Object.assign(request, { preconnect() {} }) satisfies typeof fetch;
  const client = new GarconClient({ ...connection, fetch: fetcher });
  await expect(client.updateChatTitle({ chatId: scheduleChatId, title: 'Synthetic title' }))
    .rejects.toThrow('outcome is unknown');
  expect(request).toHaveBeenCalledTimes(1);
});
