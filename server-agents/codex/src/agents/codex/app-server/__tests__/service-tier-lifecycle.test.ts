import { describe, expect, it, mock } from 'bun:test';
import { codexServiceTier } from '../../service-tier.js';
import { createSessionFixture, holdSettingsReply } from './thread-settings-fixture.js';

const startedSession = createSessionFixture();

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
    const settings = holdSettingsReply(first.update);
    const update = runtime.updateSessionSettings('thread-1', { ...request, permissionMode: 'manualBypass' });
    let resumed: Promise<void> | undefined;
    let queued: Promise<void> | undefined;
    try {
      await settings.confirmed;
      resumed = runtime.runTurn(resume);
      await Bun.sleep(0);
      queued = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'high' });
      settings.release();
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
      settings.release();
      first.finish();
      await update;
      await queued;
      await resumed;
    }
  });
});
