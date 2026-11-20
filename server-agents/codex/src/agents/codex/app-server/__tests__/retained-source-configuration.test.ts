import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexExecutionRequest } from '../../runtime-types.js';
import { CodexAppServerClient } from '../client.js';
import type { CodexTurn, ThreadSettingsUpdatedNotification, ThreadStartResponse } from '../protocol.js';
import { CodexAppServerRuntime } from '../runtime.js';

type ConfigurationAction = 'turn' | 'compaction' | 'settings' | 'deferred validation';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function idleSource() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-retained-configuration-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const nativePath = path.join(directory, 'thread.jsonl');
  await writeFile(nativePath, '{}\n');
  const client = new CodexAppServerClient();
  spyOn(client, 'connect').mockResolvedValue({
    userAgent: 'codex', codexHome: directory, platformFamily: 'unix', platformOs: 'linux',
  });
  const response = {
    thread: {
      id: 'thread-1', forkedFromId: null, preview: '', ephemeral: false, modelProvider: 'openai',
      createdAt: 0, updatedAt: 0, status: { type: 'idle' }, path: nativePath, cwd: directory,
      cliVersion: '0.169.0', source: null, agentNickname: null, agentRole: null, gitInfo: null,
      name: null, turns: [],
    },
    model: 'gpt-6.2', modelProvider: 'openai', serviceTier: 'ultrafast', cwd: directory,
    approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
    reasoningEffort: 'low',
  } satisfies ThreadStartResponse;
  spyOn(client, 'startThread').mockResolvedValue(response);
  const turn = {
    id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null,
    startedAt: 0, completedAt: null, durationMs: null,
  } satisfies CodexTurn;
  let turnNumber = 0;
  const nextTurn = () => {
    turn.id = `turn-${++turnNumber}`;
    client.emit('notification', { method: 'turn/started', params: { threadId: response.thread.id, turn } });
    return { turn };
  };
  const startTurn = spyOn(client, 'startTurn').mockImplementation(async () => nextTurn());
  const compact = spyOn(client, 'compactThread').mockImplementation(async () => {
    nextTurn();
    return {};
  });
  const shutdown = spyOn(client, 'shutdown').mockResolvedValue();
  const runtime = new CodexAppServerRuntime({
    createClient: () => client,
    retainedSourceIdlePurge: { intervalMs: 5, maxIdleMs: 0 },
  });
  cleanups.push(() => runtime.shutdown());
  const request = {
    chatId: 'chat-1', command: 'test', projectPath: directory, model: response.model,
    modelEndpointId: null, permissionMode: 'default', thinkingMode: 'low', speed: 'ultrafast',
    operation: { chatId: 'chat-1', runId: 'run-1', publish() {} },
  } satisfies CodexExecutionRequest;
  await runtime.startSession(request);
  const complete = () => client.emit('notification', {
    method: 'turn/completed', params: { threadId: response.thread.id, turn: { ...turn, status: 'completed' } },
  });
  complete();

  const discoveryStarted = Promise.withResolvers<void>();
  const discovery = Promise.withResolvers<void>();
  const catalog = { data: [{ model: request.model, serviceTiers: [{ id: 'ultrafast' }] }] };
  const feature = { name: 'ultrafast_mode', enabled: true };
  const readCatalog = mock(async (method: string): Promise<unknown> => {
    if (method === 'model/list') {
      discoveryStarted.resolve();
      await discovery.promise;
      return catalog;
    }
    if (method === 'experimentalFeature/list') return { data: [feature] };
    throw new Error(`Unexpected request: ${method}`);
  });
  spyOn(client, 'request').mockImplementation(async <T>(method: string) => await readCatalog(method) as T);
  const resume = { ...request, agentSessionId: response.thread.id,
    operation: { ...request.operation, runId: 'run-2' } };
  function configure(action: ConfigurationAction): Promise<unknown> {
    switch (action) {
      case 'turn': return runtime.runTurn(resume);
      case 'compaction': return runtime.compact(resume);
      case 'settings': return runtime.updateSessionSettings(resume.agentSessionId, request);
      case 'deferred validation': return runtime.validateDeferredSpeed(resume.agentSessionId, request.model, request.speed);
    }
  }
  return { runtime, client, request, resume, startTurn, compact, shutdown, complete,
    configure, discovery, discoveryStarted, readCatalog, feature, catalog };
}

async function expectReclaimed(shutdown: () => unknown) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (shutdown()) return;
    await Bun.sleep(5);
  }
  throw new Error('Idle source was not reclaimed');
}

describe('retained Codex source configuration lifetime', () => {
  it.each(['turn', 'compaction', 'settings', 'deferred validation'] as const)(
    'keeps the source alive through %s discovery, then permits idle reclamation', async (action) => {
      const fixture = await idleSource();
      const { runtime, discoveryStarted, discovery, shutdown } = fixture;
      const settled = fixture.configure(action).then(() => null, (error: unknown) => error);
      try {
        await discoveryStarted.promise;
        runtime.startPurgeTimer();
        await Bun.sleep(30);
        expect(shutdown).not.toHaveBeenCalled();
        discovery.resolve();
        expect(await settled).toBeNull();
        if (action === 'turn') expect(fixture.startTurn).toHaveBeenCalledTimes(2);
        if (action === 'compaction') expect(fixture.compact).toHaveBeenCalledTimes(1);
        fixture.complete();
        await expectReclaimed(() => shutdown.mock.calls.length > 0);
      } finally {
        discovery.resolve();
        await settled;
      }
    },
  );

  it.each(['settings', 'reactivation'] as const)('retains the source during %s until the confirmed settings RPC settles', async (action) => {
    const { runtime, client, request, resume, discovery, discoveryStarted, shutdown, startTurn, complete } = await idleSource();
    const reply = Promise.withResolvers<void>();
    const confirmed = Promise.withResolvers<void>();
    spyOn(client, 'updateThreadSettings').mockImplementation(async (params) => {
      client.emit('notification', {
        method: 'thread/settings/updated',
        params: {
          threadId: params.threadId,
          threadSettings: { ...params, cwd: request.projectPath, modelProvider: 'openai', effort: params.effort ?? null },
        } satisfies ThreadSettingsUpdatedNotification,
      });
      confirmed.resolve();
      await reply.promise;
      return {};
    });
    const update = runtime.updateSessionSettings(resume.agentSessionId, { ...request, thinkingMode: 'medium' });
    const settled = update.then(() => null, (error: unknown) => error);
    let resumed: Promise<unknown> | undefined;
    try {
      await discoveryStarted.promise;
      discovery.resolve();
      await confirmed.promise;
      if (action === 'reactivation') resumed = runtime.runTurn(resume).then(() => null, (error: unknown) => error);
      runtime.startPurgeTimer();
      await Bun.sleep(30);
      expect(shutdown).not.toHaveBeenCalled();
      expect(startTurn).toHaveBeenCalledTimes(1);
      reply.resolve();
      expect(await settled).toBeNull();
      if (resumed) {
        expect(await resumed).toBeNull();
        expect(startTurn).toHaveBeenCalledTimes(2);
        complete();
      }
      await expectReclaimed(() => shutdown.mock.calls.length > 0);
    } finally {
      discovery.resolve();
      reply.resolve();
      await settled;
      await resumed;
    }
  });

  it('keeps overlapping validations reserved independently', async () => {
    const { runtime, request, resume, readCatalog, catalog, feature, shutdown } = await idleSource();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const bothStarted = Promise.withResolvers<void>();
    let reads = 0;
    readCatalog.mockImplementation(async (method) => {
      if (method !== 'model/list') return { data: [feature] };
      const barrier = reads++ === 0 ? first : second;
      if (reads === 2) bothStarted.resolve();
      await barrier.promise;
      return catalog;
    });
    const validate = () => runtime.validateDeferredSpeed(resume.agentSessionId, request.model, request.speed);
    const firstResult = validate().then(() => null, (error: unknown) => error);
    const secondResult = validate().then(() => null, (error: unknown) => error);
    try {
      await bothStarted.promise;
      runtime.startPurgeTimer();
      first.resolve();
      expect(await firstResult).toBeNull();
      await Bun.sleep(30);
      expect(shutdown).not.toHaveBeenCalled();
      second.resolve();
      expect(await secondResult).toBeNull();
      await expectReclaimed(() => shutdown.mock.calls.length > 0);
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all([firstResult, secondResult]);
    }
  });

  it.each(['turn', 'settings', 'deferred validation'] as const)(
    'does not prevent explicit source release during %s discovery', async (action) => {
      const { runtime, request, resume, configure, discoveryStarted, discovery, shutdown, startTurn } = await idleSource();
      const settled = configure(action).then(() => null, (error: unknown) => error);
      try {
        await discoveryStarted.promise;
        await runtime.releaseSession(request.chatId, resume.agentSessionId);
        expect(shutdown).toHaveBeenCalledTimes(1);
        discovery.resolve();
        expect(await settled).toMatchObject({ code: 'SESSION_BUSY' });
        expect(startTurn).toHaveBeenCalledTimes(1);
      } finally {
        discovery.resolve();
        await settled;
      }
    },
  );

  it.each(['turn', 'settings', 'deferred validation'] as const)(
    'releases the reservation after %s discovery rejects', async (action) => {
      const { runtime, configure, discoveryStarted, discovery, feature, shutdown } = await idleSource();
      feature.enabled = false;
      const settled = configure(action).then(() => null, (error: unknown) => error);
      try {
        await discoveryStarted.promise;
        runtime.startPurgeTimer();
        discovery.resolve();
        expect(await settled).toMatchObject({ code: 'INVALID_SETTINGS' });
        await expectReclaimed(() => shutdown.mock.calls.length > 0);
      } finally {
        discovery.resolve();
        await settled;
      }
    },
  );

  it('releases a reactivation reservation when admission is cancelled during discovery', async () => {
    const { runtime, resume, discoveryStarted, discovery, shutdown, startTurn } = await idleSource();
    const controller = new AbortController();
    const operation = runtime.runTurn({ ...resume,
      executionAdmission: { signal: controller.signal, async markStarted() {} } });
    const settled = operation.then(() => null, (error: unknown) => error);
    try {
      await discoveryStarted.promise;
      runtime.startPurgeTimer();
      controller.abort(new Error('Admission cancelled'));
      discovery.resolve();
      expect(await settled).toMatchObject({ message: 'Admission cancelled' });
      expect(startTurn).toHaveBeenCalledTimes(1);
      await expectReclaimed(() => shutdown.mock.calls.length > 0);
    } finally {
      discovery.resolve();
      await settled;
    }
  });
});
