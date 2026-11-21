import { afterEach, mock, spyOn, type Mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import type { CodexExecutionRequest } from '../../runtime-types.js';
import { codexServiceTier, type CodexServiceTier, type CodexSpeed } from '../../service-tier.js';
import { CodexAppServerClient } from '../client.js';
import type { CodexTurn, ThreadSettingsUpdatedNotification, ThreadStartResponse } from '../protocol.js';
import type { CodexAppServerRuntimeOptions } from '../runtime-session-state.js';
import { CodexAppServerRuntime } from '../runtime.js';

async function createThreadFixture(directory: string, serviceTier: CodexServiceTier) {
  const nativePath = path.join(directory, 'thread.jsonl');
  const meta = { type: 'session_meta', payload: {
    id: 'thread-1', timestamp: '2026-11-20T00:00:00Z', cwd: directory,
  } };
  await writeFile(nativePath, JSON.stringify(meta) + '\n');
  const response = {
    thread: {
      id: meta.payload.id, forkedFromId: null, preview: '', ephemeral: false, modelProvider: 'openai',
      createdAt: 0, updatedAt: 0, status: { type: 'idle' }, path: nativePath, cwd: directory,
      cliVersion: '0.169.0', source: null, agentNickname: null, agentRole: null, gitInfo: null,
      name: null, turns: [],
    },
    model: 'model-a', modelProvider: 'openai', serviceTier, cwd: directory,
    approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
    reasoningEffort: 'low',
  } satisfies ThreadStartResponse;
  return { nativePath, response };
}

// Lets the native settings notification arrive before the RPC reply.
export function holdSettingsReply(update: Mock<CodexAppServerClient['updateThreadSettings']>) {
  const confirmed = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const apply = update.getMockImplementation()!;
  update.mockImplementation(async (params) => {
    const result = await apply(params);
    confirmed.resolve();
    await reply.promise;
    return result;
  });
  return { confirmed: confirmed.promise, release: reply.resolve };
}

type SessionFixtureOptions = Pick<CodexAppServerRuntimeOptions, 'retainedSourceIdlePurge'>;

export function createSessionFixture(options: SessionFixtureOptions = {}) {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  return (speed: CodexSpeed = 'ultrafast', thinkingMode: CodexExecutionRequest['thinkingMode'] = 'low') =>
    startFixtureSession(cleanups, options, speed, thinkingMode);
}

async function startFixtureSession(
  cleanups: (() => Promise<void>)[],
  options: SessionFixtureOptions,
  speed: CodexSpeed,
  thinkingMode: CodexExecutionRequest['thinkingMode'],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-tier-lifecycle-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { nativePath, response } = await createThreadFixture(directory, codexServiceTier(speed));
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
      userAgent: 'garcon/0.171.0', codexHome: directory, platformFamily: 'unix', platformOs: 'linux',
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
  const runtime = new CodexAppServerRuntime({
    ...options,
    createClient: () => {
      const created = createClient();
      clients.push(created);
      return created.client;
    },
    capacityRetryDelaysMs: [0],
    capacityRetryDelay: backoff,
  });
  cleanups.push(() => runtime.shutdown());
  await runtime.startSession(request);
  const first = clients[0]!;
  const resume = { ...request, agentSessionId: 'thread-1', nativePath,
    operation: { ...request.operation, runId: 'run-2' } };
  return { runtime, request, resume, clients, first, events, terminal, backoff,
    denyResume() { resumedTier = 'default'; } };
}
