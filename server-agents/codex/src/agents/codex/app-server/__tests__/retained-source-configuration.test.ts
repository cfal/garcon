import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexExecutionRequest } from '../../runtime-types.js';
import { CodexAppServerClient } from '../client.js';
import type { CodexTurn, ThreadSettingsUpdatedNotification, ThreadStartResponse } from '../protocol.js';
import { CodexAppServerRuntime } from '../runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function idleSource() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-retained-configuration-'));
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
    model: 'model-a', modelProvider: 'openai', serviceTier: 'default', cwd: directory,
    approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
    reasoningEffort: 'low',
  } satisfies ThreadStartResponse;
  let turnNumber = 0;
  function createClient() {
    const client = new CodexAppServerClient();
    spyOn(client, 'connect').mockResolvedValue({
      userAgent: 'codex', codexHome: directory, platformFamily: 'unix', platformOs: 'linux',
    });
    spyOn(client, 'startThread').mockResolvedValue(response);
    spyOn(client, 'resumeThread').mockImplementation(async (params) => ({ ...response, serviceTier: String(params.serviceTier) }));
    let turn: CodexTurn;
    const startTurn = spyOn(client, 'startTurn').mockImplementation(async () => {
      turn = { id: `turn-${++turnNumber}`, items: [], itemsView: 'full', status: 'inProgress',
        error: null, startedAt: 0, completedAt: null, durationMs: null };
      client.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn } });
      return { turn };
    });
    const shutdown = spyOn(client, 'shutdown').mockResolvedValue();
    const update = spyOn(client, 'updateThreadSettings').mockImplementation(async (params) => {
      client.emit('notification', { method: 'thread/settings/updated', params: {
        threadId: params.threadId,
        threadSettings: { ...params, cwd: directory, modelProvider: 'openai', serviceTier: 'default', effort: params.effort ?? null },
      } satisfies ThreadSettingsUpdatedNotification });
      return {};
    });
    const complete = () => client.emit('notification', {
      method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...turn, status: 'completed' } },
    });
    return { client, shutdown, update, startTurn, complete };
  }
  const clients: ReturnType<typeof createClient>[] = [];
  const runtime = new CodexAppServerRuntime({
    createClient: () => { const source = createClient(); clients.push(source); return source.client; },
    retainedSourceIdlePurge: { intervalMs: 5, maxIdleMs: 0 },
  });
  cleanups.push(() => runtime.shutdown());
  const request = {
    chatId: 'chat-1', command: 'test', projectPath: directory, model: response.model,
    modelEndpointId: null, permissionMode: 'default', thinkingMode: 'low', speed: 'standard',
    operation: { chatId: 'chat-1', runId: 'run-1', publish() {} },
  } satisfies CodexExecutionRequest;
  await runtime.startSession(request);
  const first = clients[0]!;
  first.complete();
  const resume = { ...request, agentSessionId: 'thread-1', nativePath,
    operation: { ...request.operation, runId: 'run-2' } };
  return { runtime, request, resume, clients, first };
}

async function expectReclaimed(shutdown: () => unknown) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (shutdown()) return;
    await Bun.sleep(5);
  }
  throw new Error('Idle source was not reclaimed');
}

describe('retained Codex source settings lifetime', () => {
  it('settles settings that arrive during native-path resolution before replacing the writer', async () => {
    const { runtime, request, resume, clients, first } = await idleSource();
    const nativeContents = await readFile(resume.nativePath, 'utf8');
    await rm(resume.nativePath);
    const pathRequested = Promise.withResolvers<void>();
    const pathReply = Promise.withResolvers<void>();
    spyOn(runtime, 'resolveNativePath').mockImplementation(async () => {
      pathRequested.resolve();
      await pathReply.promise;
      return resume.nativePath;
    });
    const reply = Promise.withResolvers<void>();
    const confirmed = Promise.withResolvers<void>();
    const apply = first.update.getMockImplementation()!;
    first.update.mockImplementation(async (params) => {
      await apply(params);
      confirmed.resolve();
      await reply.promise;
      return {};
    });
    const resumed = runtime.runTurn({ ...resume, speed: 'ultrafast' });
    let update: Promise<void> | undefined;
    try {
      await pathRequested.promise;
      await writeFile(resume.nativePath, nativeContents);
      update = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'medium' });
      await confirmed.promise;
      pathReply.resolve();
      await Bun.sleep(25);
      expect(first.shutdown).not.toHaveBeenCalled();
      expect(clients).toHaveLength(1);
      reply.resolve();
      await update;
      await resumed;
      expect(first.shutdown).toHaveBeenCalledTimes(1);
      expect(clients).toHaveLength(2);
    } finally {
      pathReply.resolve();
      reply.resolve();
      await update;
      await resumed;
    }
  });

  it.each(['settings only', 'standard', 'ultrafast'] as const)(
    'retains the source until the confirmed settings RPC settles before %s', async (action) => {
      const { runtime, request, resume, clients, first } = await idleSource();
      const reply = Promise.withResolvers<void>();
      const confirmed = Promise.withResolvers<void>();
      const apply = first.update.getMockImplementation()!;
      first.update.mockImplementation(async (params) => {
        await apply(params);
        confirmed.resolve();
        await reply.promise;
        return {};
      });
      const update = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'medium' });
      let resumed: Promise<void> | undefined;
      try {
        await confirmed.promise;
        if (action !== 'settings only') resumed = runtime.runTurn({ ...resume, speed: action });
        runtime.startPurgeTimer();
        await Bun.sleep(30);
        expect(first.shutdown).not.toHaveBeenCalled();
        expect(clients).toHaveLength(1);
        expect(first.startTurn).toHaveBeenCalledTimes(1);
        reply.resolve();
        await update;
        await resumed;
        if (action === 'standard') expect(first.startTurn).toHaveBeenCalledTimes(2);
        if (action === 'ultrafast') expect(clients).toHaveLength(2);
        clients.at(-1)!.complete();
        await expectReclaimed(() => clients.at(-1)!.shutdown.mock.calls.length > 0);
      } finally {
        reply.resolve();
        await update;
        await resumed;
      }
    },
  );

  it.each(['release', 'cancel', 'queued write', 'competing turn'] as const)(
    'rechecks admission and queued writes after settings settle: %s', async (action) => {
      const { runtime, request, resume, clients, first } = await idleSource();
      const reply = Promise.withResolvers<void>();
      const confirmed = Promise.withResolvers<void>();
      const apply = first.update.getMockImplementation()!;
      first.update.mockImplementation(async (params) => {
        await apply(params);
        confirmed.resolve();
        await reply.promise;
        return {};
      });
      const update = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'medium' });
      await confirmed.promise;
      const controller = new AbortController();
      const resumed = runtime.runTurn({ ...resume, speed: action === 'competing turn' ? 'standard' : 'ultrafast',
        executionAdmission: { signal: controller.signal, async markStarted() {} } })
        .then(() => null, (error: unknown) => error);
      let queued: Promise<unknown> | undefined;
      try {
        if (action === 'release') {
          queued = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'high' })
            .then(() => null, (error: unknown) => error);
          await runtime.releaseSession(request.chatId, 'thread-1');
        } else if (action === 'cancel') {
          controller.abort(new Error('Admission cancelled'));
        } else if (action === 'competing turn') {
          queued = runtime.runTurn({ ...resume, operation: { ...resume.operation, runId: 'run-3' } })
            .then(() => null, (error: unknown) => error);
        } else {
          queued = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'high' });
        }
        reply.resolve();
        await update;
        if (action === 'release') {
          expect(await resumed).toMatchObject({ code: 'SESSION_BUSY' });
          expect(await queued).toMatchObject({ code: 'SESSION_BUSY' });
          expect(first.update).toHaveBeenCalledTimes(1);
        } else if (action === 'cancel') {
          expect(await resumed).toMatchObject({ message: 'Admission cancelled' });
        } else if (action === 'competing turn') {
          expect(await resumed).toBeNull();
          expect(await queued).toMatchObject({ code: 'SESSION_BUSY' });
          expect(first.startTurn).toHaveBeenCalledTimes(2);
        } else {
          await queued;
          expect(await resumed).toBeNull();
          expect(first.update).toHaveBeenCalledTimes(2);
          expect(clients).toHaveLength(2);
        }
        if (action !== 'queued write') expect(clients).toHaveLength(1);
      } finally {
        reply.resolve();
        await update;
        await queued;
        await resumed;
      }
    },
  );
});
