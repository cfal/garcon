import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { CodexExecutionRequest } from '../../runtime-types.js';
import { CodexAppServerClient } from '../client.js';
import type { CodexTurn, ThreadSettingsUpdatedNotification, ThreadStartResponse } from '../protocol.js';
import { CodexAppServerRuntime } from '../runtime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startedSession() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-tier-lifecycle-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const nativePath = path.join(directory, 'thread.jsonl');
  await writeFile(nativePath, '{}\n');
  const response = {
    thread: {
      id: 'thread-1', forkedFromId: null, preview: '', ephemeral: false, modelProvider: 'openai',
      createdAt: 0, updatedAt: 0, status: { type: 'idle' }, path: nativePath, cwd: directory,
      cliVersion: '0.169.0', source: null, agentNickname: null, agentRole: null, gitInfo: null,
      name: null, turns: [],
    },
    model: 'model-a', modelProvider: 'openai', serviceTier: 'ultrafast', cwd: directory,
    approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
    reasoningEffort: 'low',
  } satisfies ThreadStartResponse;
  const events: AgentRuntimeEvent[] = [];
  const terminal = deferred();
  const request = {
    chatId: 'chat-1', command: 'Synthetic prompt', projectPath: directory, model: response.model,
    modelEndpointId: null, permissionMode: 'default', thinkingMode: 'low', speed: 'ultrafast',
    operation: { chatId: 'chat-1', runId: 'run-1', publish(event: AgentRuntimeEvent) {
      events.push(event);
      if (event.type === 'run-ended') terminal.resolve();
    } },
  } satisfies CodexExecutionRequest;
  let turnNumber = 0;
  let turn: CodexTurn;
  function createClient() {
    const client = new CodexAppServerClient();
    spyOn(client, 'connect').mockResolvedValue({
      userAgent: 'codex', codexHome: directory, platformFamily: 'unix', platformOs: 'linux',
    });
    spyOn(client, 'shutdown').mockResolvedValue();
    spyOn(client, 'startThread').mockResolvedValue(response);
    const resume = spyOn(client, 'resumeThread').mockImplementation(async (params) => ({
      ...response, model: typeof params.model === 'string' ? params.model : response.model,
    }));
    const startTurn = spyOn(client, 'startTurn').mockImplementation(async () => {
      turn = { id: `turn-${++turnNumber}`, items: [], itemsView: 'full', status: 'inProgress',
        error: null, startedAt: 0, completedAt: null, durationMs: null };
      client.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn } });
      return { turn };
    });
    const discovery = mock(async (method: string): Promise<unknown> => ({ data: method === 'model/list'
      ? ['model-a', 'model-b'].map((model) => ({ model, serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] }))
      : [{ name: 'ultrafast_mode', enabled: true }, { name: 'fast_mode', enabled: true }] }));
    spyOn(client, 'request').mockImplementation(async <T>(method: string) => await discovery(method) as T);
    const confirm = (settings: Partial<ThreadSettingsUpdatedNotification['threadSettings']> = {}) => {
      client.emit('notification', { method: 'thread/settings/updated', params: {
        threadId: 'thread-1', threadSettings: { cwd: directory, modelProvider: 'openai', model: response.model,
          serviceTier: 'ultrafast', effort: 'low', approvalPolicy: 'never', approvalsReviewer: 'user',
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
    return { client, resume, startTurn, discovery, confirm, update, finish };
  }
  const clients: ReturnType<typeof createClient>[] = [];
  const runtime = new CodexAppServerRuntime({ createClient: () => {
    const created = createClient();
    clients.push(created);
    return created.client;
  }, capacityRetryDelaysMs: [0] });
  cleanups.push(() => runtime.shutdown());
  await runtime.startSession(request);
  const first = clients[0]!;
  const failCapacity = () => first.finish({ message: 'Selected model is at capacity',
    codexErrorInfo: 'serverOverloaded', additionalDetails: null });
  const ended = () => events.filter((event) => event.type === 'run-ended');
  return { runtime, request, clients, first, events, ended, terminal, failCapacity };
}

describe('Codex premium route lifecycle', () => {
  it.each(['disabled gate', 'missing tier', 'discovery timeout'] as const)(
    'fails a capacity retry exactly once after %s', async (denial) => {
      const { runtime, first, failCapacity, terminal, ended } = await startedSession();
      first.discovery.mockImplementation(async (method) => {
        if (denial === 'discovery timeout') throw new AgentIntegrationError('TIMEOUT', 'Discovery timed out', true);
        return { data: method === 'model/list'
          ? [{ model: 'model-a', serviceTiers: denial === 'missing tier' ? [] : [{ id: 'ultrafast' }] }]
          : [{ name: 'ultrafast_mode', enabled: denial !== 'disabled gate' }] };
      });
      failCapacity();
      await terminal.promise;
      await Bun.sleep(0);
      expect(first.discovery.mock.calls.map(([method]) => method)).toEqual(['model/list', 'experimentalFeature/list']);
      expect(first.startTurn).toHaveBeenCalledTimes(1);
      expect(ended()).toEqual([expect.objectContaining({ type: 'run-ended', outcome: 'failed',
        error: expect.objectContaining({ message: expect.stringContaining(denial === 'discovery timeout' ? 'timed out' : 'Ultrafast speed is unavailable') }),
      })]);
      expect(runtime.isRunning('thread-1')).toBe(false);
    },
  );

  it('fences a late successful retry discovery after explicit source release', async () => {
    const { runtime, request, first, events, failCapacity } = await startedSession();
    const checking = deferred();
    const reply = deferred();
    const discover = first.discovery.getMockImplementation()!;
    first.discovery.mockImplementation(async (method) => { checking.resolve(); await reply.promise; return discover(method); });
    failCapacity();
    try {
      await checking.promise;
      await runtime.releaseSession(request.chatId, 'thread-1');
      const beforeReply = [...events];
      reply.resolve();
      await Bun.sleep(0);
      expect(first.startTurn).toHaveBeenCalledTimes(1);
      expect(events).toEqual(beforeReply);
      expect(runtime.isRunning('thread-1')).toBe(false);
    } finally {
      reply.resolve();
    }
  });

  it('reopens a premium source after a live model change instead of trusting its old activation', async () => {
    const { runtime, request, clients, first } = await startedSession();
    first.finish();
    await runtime.updateSessionSettings('thread-1', { ...request, model: 'model-b' });
    expect(first.update).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-b', serviceTier: 'ultrafast' }));
    await runtime.runTurn({ ...request, model: 'model-b', agentSessionId: 'thread-1',
      operation: { ...request.operation, runId: 'run-2' } });
    expect(clients).toHaveLength(2);
    expect(clients[1]!.resume).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-b', serviceTier: 'ultrafast' }));
    expect(clients[1]!.startTurn).toHaveBeenCalledTimes(1);
    expect(first.startTurn).toHaveBeenCalledTimes(1);
  });

  it.each([['fast', 'priority'], ['fast', 'fast'], ['ultrafast', 'ultrafast']] as const)(
    'confirms %s using the %s echo, not a wrong tier or an unrelated turn reply', async (speed, echo) => {
      const { runtime, request, first } = await startedSession();
      first.finish();
      const turnStarted = deferred();
      const turnReply = deferred();
      const start = first.startTurn.getMockImplementation()!;
      first.startTurn.mockImplementation(async (params) => {
        const result = await start(params);
        turnStarted.resolve();
        await turnReply.promise;
        return result;
      });
      const resumed = runtime.runTurn({ ...request, agentSessionId: 'thread-1', operation: { ...request.operation, runId: 'run-2' } });
      const applying = deferred();
      first.update.mockImplementation(async () => { applying.resolve(); return {}; });
      let update: Promise<void> | undefined;
      try {
        await turnStarted.promise;
        let settled = false;
        update = runtime.updateSessionSettings('thread-1', { ...request, speed, thinkingMode: 'medium' })
          .then(() => { settled = true; });
        await applying.promise;
        first.confirm({ serviceTier: 'default', effort: 'medium' });
        await Bun.sleep(0);
        expect(settled).toBe(false);
        first.confirm({ serviceTier: echo, effort: 'medium' });
        await update;
        expect(first.update).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: speed === 'fast' ? 'priority' : 'ultrafast' }));
        expect(settled).toBe(true);
        turnReply.resolve();
        await resumed;
        first.update.mockImplementation(async () => {
          first.confirm({ serviceTier: echo, effort: 'medium' });
          return {};
        });
        await runtime.updateSessionSettings('thread-1', { ...request, speed, thinkingMode: 'medium' });
        expect(first.update).toHaveBeenCalledTimes(1);
      } finally {
        turnReply.resolve();
        first.confirm({ serviceTier: echo, effort: 'medium' });
        await resumed;
        await update;
      }
    },
  );
});
