import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import type { CodexExecutionRequest } from '../../runtime-types.js';
import { codexServiceTier, type CodexSpeed } from '../../service-tier.js';
import { CodexAppServerClient } from '../client.js';
import type { CodexTurn, ThreadSettingsUpdatedNotification, ThreadStartResponse } from '../protocol.js';
import { CodexAppServerRuntime } from '../runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startedSession(speed: CodexSpeed = 'ultrafast', thinkingMode: CodexExecutionRequest['thinkingMode'] = 'low') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-tier-lifecycle-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const nativePath = path.join(directory, 'thread.jsonl');
  await writeFile(nativePath, JSON.stringify({ type: 'session_meta', payload: {
    id: 'thread-1', timestamp: '2026-11-20T00:00:00Z', cwd: directory,
  } }) + '\n');
  const response = {
    thread: {
      id: 'thread-1', forkedFromId: null, preview: '', ephemeral: false, modelProvider: 'openai',
      createdAt: 0, updatedAt: 0, status: { type: 'idle' }, path: nativePath, cwd: directory,
      cliVersion: '0.169.0', source: null, agentNickname: null, agentRole: null, gitInfo: null,
      name: null, turns: [],
    },
    model: 'model-a', modelProvider: 'openai', serviceTier: codexServiceTier(speed), cwd: directory,
    approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
    reasoningEffort: 'low',
  } satisfies ThreadStartResponse;
  const events: AgentRuntimeEvent[] = [];
  const terminal = Promise.withResolvers<void>();
  const request = {
    chatId: 'chat-1', command: 'Synthetic prompt', projectPath: directory, model: response.model,
    modelEndpointId: null, permissionMode: 'default', thinkingMode, speed,
    operation: { chatId: 'chat-1', runId: 'run-1', publish(event: AgentRuntimeEvent) {
      events.push(event);
      if (event.type === 'run-ended') terminal.resolve();
    } },
  } satisfies CodexExecutionRequest;
  let turnNumber = 0;
  let resumedTier: string | undefined;
  function createClient() {
    const client = new CodexAppServerClient();
    let turn: CodexTurn;
    spyOn(client, 'connect').mockResolvedValue({
      userAgent: 'codex', codexHome: directory, platformFamily: 'unix', platformOs: 'linux',
    });
    const shutdown = spyOn(client, 'shutdown').mockResolvedValue();
    spyOn(client, 'startThread').mockResolvedValue(response);
    const resume = spyOn(client, 'resumeThread').mockImplementation(async (params) => ({
      ...response,
      model: typeof params.model === 'string' ? params.model : response.model,
      serviceTier: resumedTier ?? String(params.serviceTier),
    }));
    const nextTurn = () => {
      turn = { id: `turn-${++turnNumber}`, items: [], itemsView: 'full', status: 'inProgress',
        error: null, startedAt: 0, completedAt: null, durationMs: null };
      client.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn } });
      return { turn };
    };
    const startTurn = spyOn(client, 'startTurn').mockImplementation(async () => nextTurn());
    const compact = spyOn(client, 'compactThread').mockImplementation(async () => { nextTurn(); return {}; });
    spyOn(client, 'interruptTurn').mockResolvedValue({});
    const rpc = spyOn(client, 'request').mockRejectedValue(new Error('Unexpected native RPC'));
    const confirm = (settings: Partial<ThreadSettingsUpdatedNotification['threadSettings']> = {}) => {
      client.emit('notification', { method: 'thread/settings/updated', params: {
        threadId: 'thread-1', threadSettings: { cwd: directory, modelProvider: 'openai', model: response.model,
          serviceTier: codexServiceTier(speed), effort: 'low', approvalPolicy: 'never', approvalsReviewer: 'user',
          sandboxPolicy: { type: 'workspaceWrite' }, ...settings },
      } satisfies ThreadSettingsUpdatedNotification });
    };
    const update = spyOn(client, 'updateThreadSettings').mockImplementation(async (params) => {
      confirm({ ...params, effort: params.effort ?? null });
      return {};
    });
    const finish = (error: CodexTurn['error'] = null) => {
      if (error) client.emit('notification', { method: 'error', params: {
        threadId: 'thread-1', turnId: turn.id, willRetry: false, error,
      } });
      client.emit('notification', { method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { ...turn, status: error ? 'failed' : 'completed', error },
      } });
    };
    return { client, resume, startTurn, compact, shutdown, rpc, confirm, update, finish };
  }
  const clients: ReturnType<typeof createClient>[] = [];
  const backoff = mock(async () => {});
  const runtime = new CodexAppServerRuntime({ createClient: () => {
    const created = createClient();
    clients.push(created);
    return created.client;
  }, capacityRetryDelaysMs: [0], capacityRetryDelay: backoff });
  cleanups.push(() => runtime.shutdown());
  await runtime.startSession(request);
  const first = clients[0]!;
  const resume = { ...request, agentSessionId: 'thread-1', nativePath,
    operation: { ...request.operation, runId: 'run-2' } };
  return { runtime, request, resume, clients, first, events, terminal, backoff,
    denyResume() { resumedTier = 'default'; } };
}

describe('Codex admission-time speed', () => {
  it.each(['standard', 'fast', 'ultrafast'] as const)('reuses only Standard sources, starting from %s', async (speed) => {
    const { runtime, resume, clients, first } = await startedSession(speed);
    first.finish();
    await runtime.runTurn(resume);
    expect(clients).toHaveLength(speed === 'standard' ? 1 : 2);
    const active = clients.at(-1)!;
    expect(active.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ serviceTier: codexServiceTier(speed) }));
    if (speed !== 'standard') {
      expect(first.shutdown).toHaveBeenCalledTimes(1);
      expect(active.resume).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1', path: resume.nativePath,
        model: resume.model, serviceTier: codexServiceTier(speed) }));
      expect(first.startTurn).toHaveBeenCalledTimes(1);
    }
    for (const source of clients) expect(source.rpc).not.toHaveBeenCalled();
  });

  it.each(['turn', 'compaction'] as const)('rejects a downgraded fresh premium %s before inference', async (action) => {
    const { runtime, resume, clients, first, denyResume } = await startedSession();
    first.finish();
    denyResume();
    const markStarted = mock(async () => {});
    const request = { ...resume, executionAdmission: { signal: new AbortController().signal, markStarted } };
    const operation = action === 'turn' ? runtime.runTurn(request) : runtime.compact(request);
    await expect(operation).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    expect(markStarted).not.toHaveBeenCalled();
    expect(clients[1]!.startTurn).not.toHaveBeenCalled();
    expect(clients[1]!.compact).not.toHaveBeenCalled();
    expect(clients[1]!.shutdown).toHaveBeenCalledTimes(1);
  });

  it.each(['standard', 'fast', 'ultrafast'] as const)('freshly resumes a premium source before %s compaction', async (speed) => {
    const { runtime, resume, clients, first } = await startedSession();
    first.finish();
    await runtime.compact({ ...resume, speed });
    expect(clients).toHaveLength(2);
    expect(clients[1]!.resume).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: codexServiceTier(speed) }));
    expect(clients[1]!.compact).toHaveBeenCalledWith('thread-1');
    expect(first.compact).not.toHaveBeenCalled();
  });

  it('freshly resumes Standard after premium, then permits Standard reuse', async () => {
    const { runtime, resume, clients, first } = await startedSession();
    first.finish();
    await runtime.runTurn({ ...resume, speed: 'standard' });
    expect(clients).toHaveLength(2);
    const standard = clients[1]!;
    expect(standard.resume).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: 'default' }));
    standard.finish();
    await runtime.runTurn({ ...resume, speed: 'standard', operation: { ...resume.operation, runId: 'run-3' } });
    expect(clients).toHaveLength(2);
    expect(standard.startTurn).toHaveBeenCalledTimes(2);
  });

  it.each(['fast', 'ultrafast'] as const)('ends a %s capacity failure once without backoff or retry', async (speed) => {
    const { runtime, first, events, terminal, backoff } = await startedSession(speed);
    first.finish({ message: 'Selected model is at capacity', codexErrorInfo: 'serverOverloaded', additionalDetails: null });
    await terminal.promise;
    expect(backoff).not.toHaveBeenCalled();
    expect(first.startTurn).toHaveBeenCalledTimes(1);
    expect(first.rpc).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'run-ended')).toEqual([
      expect.objectContaining({ outcome: 'failed', error: expect.objectContaining({ message: expect.stringContaining('capacity') }) }),
    ]);
    expect(runtime.isRunning('thread-1')).toBe(false);
  });

  it('keeps ordinary settings writes tier-free and reopens after a model change', async () => {
    const { runtime, request, resume, clients, first } = await startedSession();
    first.finish();
    await runtime.updateSessionSettings('thread-1', { ...request, model: 'model-b', thinkingMode: 'medium' });
    expect(first.update).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-b', effort: 'medium' }));
    expect(first.update.mock.calls[0]![0]).not.toHaveProperty('serviceTier');
    await runtime.runTurn({ ...resume, model: 'model-b' });
    expect(clients[1]!.resume).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-b', serviceTier: 'ultrafast' }));
    expect(first.rpc).not.toHaveBeenCalled();
  });

  it('confirms non-speed settings independently of the tier echo or a delayed turn reply', async () => {
    const { runtime, request, resume, first } = await startedSession('standard');
    first.finish();
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    const start = first.startTurn.getMockImplementation()!;
    first.startTurn.mockImplementation(async (params) => {
      const result = await start(params);
      started.resolve();
      await reply.promise;
      return result;
    });
    const resumed = runtime.runTurn(resume);
    try {
      await started.promise;
      first.update.mockImplementation(async () => { first.confirm({ serviceTier: 'fast', effort: 'medium' }); return {}; });
      await runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'medium' });
      reply.resolve();
      await resumed;
      await runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'medium' });
      expect(first.update).toHaveBeenCalledTimes(1);
    } finally {
      reply.resolve();
      await resumed;
    }
  });

  it.each([false, true])('waits for a premium interrupt terminal before replacing the writer (cancel: %s)', async (cancel) => {
    const { runtime, resume, clients, first } = await startedSession();
    await runtime.abort('thread-1');
    const controller = new AbortController();
    const pending = runtime.runTurn({ ...resume,
      executionAdmission: { signal: controller.signal, async markStarted() {} } }).then(() => null, (error: unknown) => error);
    try {
      await Bun.sleep(0);
      expect(clients).toHaveLength(1);
      expect(first.shutdown).not.toHaveBeenCalled();
      if (cancel) controller.abort(new Error('Admission cancelled'));
      first.finish();
      if (cancel) {
        expect(await pending).toMatchObject({ message: 'Admission cancelled' });
        expect(clients).toHaveLength(1);
      } else {
        expect(await pending).toBeNull();
        expect(clients).toHaveLength(2);
        expect(clients[1]!.resume).toHaveBeenCalledTimes(1);
      }
    } finally {
      first.finish();
      await pending;
    }
  });

  it('rechecks interrupt reuse after a later queued settings write changes effort ownership', async () => {
    const { runtime, request, resume, clients, first } = await startedSession('standard', 'none');
    await runtime.abort('thread-1');
    const reply = Promise.withResolvers<void>();
    const confirmed = Promise.withResolvers<void>();
    const apply = first.update.getMockImplementation()!;
    first.update.mockImplementation(async (params) => {
      await apply(params);
      confirmed.resolve();
      await reply.promise;
      return {};
    });
    const update = runtime.updateSessionSettings('thread-1', { ...request, permissionMode: 'manualBypass' });
    let resumed: Promise<void> | undefined;
    let queued: Promise<void> | undefined;
    try {
      await confirmed.promise;
      resumed = runtime.runTurn(resume);
      await Bun.sleep(0);
      queued = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'high' });
      reply.resolve();
      await update;
      await queued;
      await Bun.sleep(25);
      expect(clients).toHaveLength(1);
      expect(first.shutdown).not.toHaveBeenCalled();
      expect(first.startTurn).toHaveBeenCalledTimes(1);
      first.finish();
      await resumed;
      expect(first.shutdown).toHaveBeenCalledTimes(1);
      expect(clients).toHaveLength(2);
      expect(clients[1]!.startTurn).toHaveBeenCalledTimes(1);
      expect(clients[1]!.startTurn.mock.calls[0]![0]).not.toHaveProperty('effort');
    } finally {
      reply.resolve();
      first.finish();
      await update;
      await queued;
      await resumed;
    }
  });
});
