import { describe, expect, it, mock } from 'bun:test';
import { LazyPiRuntime } from '../lazy-runtime.ts';

/** @implements {import('../lazy-runtime.js').PiRuntime} */
class FakePiRuntime {
  startSession = mock(async () => ({ agentSessionId: 'pi-session', nativePath: null }));
  runTurn = mock(async () => {});
  abort = mock(() => true);
  isRunning = mock(() => true);
  getRunningSessions = mock(() => [{ id: 'pi-session' }]);
  captureSteerTarget = mock(() => ({ provider: 'pi-target' }));
  steer = mock(async () => ({ kind: 'accepted' }));
  startPurgeTimer = mock(() => {});
  shutdown = mock(async () => {});
}

/** @returns {import('../runtime-types.js').PiStartRequest} */
function startRequest() {
  return {
    chatId: 'chat-1', projectPath: '/project', model: 'model',
    permissionMode: 'default', thinkingMode: 'none', command: 'synthetic input',
    operation: { runId: 'run-default', publish() {} },
  };
}

function turnRequest(agentSessionId = 'pi-session') {
  return { ...startRequest(), agentSessionId };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('LazyPiRuntime', () => {
  it('loads Pi only when an asynchronous runtime operation needs it', async () => {
    const loaded = new FakePiRuntime();
    const loadRuntime = mock(async () => loaded);
    const runtime = new LazyPiRuntime(loadRuntime);

    runtime.startPurgeTimer();
    expect(runtime.isRunning('pi-session')).toBe(false);
    expect(runtime.getRunningSessions()).toEqual([]);
    expect(runtime.abort('pi-session', () => {})).toBe(false);
    expect(runtime.captureSteerTarget('pi-session')).toBeNull();
    expect(loadRuntime).not.toHaveBeenCalled();

    await runtime.startSession(startRequest());

    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(loaded.startSession).toHaveBeenCalledTimes(1);
    expect(loaded.startPurgeTimer).toHaveBeenCalledTimes(1);
    expect(runtime.isRunning('pi-session')).toBe(true);
    expect(runtime.captureSteerTarget('pi-session')).toEqual({ provider: 'pi-target' });
  });

  it('routes steering through the loaded runtime without loading during capture', async () => {
    const loaded = new FakePiRuntime();
    const loadRuntime = mock(async () => loaded);
    const runtime = new LazyPiRuntime(loadRuntime);
    expect(runtime.captureSteerTarget('pi-session')).toBeNull();
    expect(loadRuntime).not.toHaveBeenCalled();

    const request = { agentSessionId: 'pi-session', target: { provider: 'pi-target' } };
    await expect(runtime.steer(request)).resolves.toEqual({ kind: 'accepted' });
    expect(loaded.steer).toHaveBeenCalledWith(request);
  });

  it('shares an in-flight load and preserves each concrete operation', async () => {
    const loaded = new FakePiRuntime();
    const loadRuntime = mock(async () => loaded);
    const runtime = new LazyPiRuntime(loadRuntime);
    const startOperation = { runId: 'run-start', publish: mock(() => {}) };
    const turnOperation = { runId: 'run-turn', publish: mock(() => {}) };
    const startInput = { ...startRequest(), operation: startOperation };
    const turnInput = { ...turnRequest(), operation: turnOperation };

    await Promise.all([runtime.startSession(startInput), runtime.runTurn(turnInput)]);

    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(loaded.startSession).toHaveBeenCalledWith(startInput);
    expect(loaded.runTurn).toHaveBeenCalledWith(turnInput);
  });

  it('cancels only the matching queued turn when aborted during loading', async () => {
    const loaded = new FakePiRuntime();
    const loader = deferred();
    const runtime = new LazyPiRuntime(() => loader.promise);
    const startInput = startRequest();
    const target = turnRequest();
    const successor = turnRequest();
    const unrelated = turnRequest('other-session');
    const start = runtime.startSession(startInput);
    const turn = runtime.runTurn(target);
    const sameSession = runtime.runTurn(successor);
    const unrelatedTurn = runtime.runTurn(unrelated);

    expect(runtime.abort('pi-session', () => {})).toBe(false);
    expect(runtime.abort('missing-session', target.operation.publish)).toBe(false);
    expect(runtime.abort('pi-session', startInput.operation.publish)).toBe(false);
    expect(runtime.abort('pi-session', target.operation.publish)).toBe(true);
    loader.resolve(loaded);

    const results = await Promise.allSettled([start, turn, sameSession, unrelatedTurn]);
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    expect(results[1].reason).toMatchObject({ name: 'AbortError' });
    expect(loaded.startSession).toHaveBeenCalledTimes(1);
    expect(loaded.runTurn).toHaveBeenCalledTimes(2);
    expect(loaded.runTurn).toHaveBeenCalledWith(successor);
    expect(loaded.runTurn).toHaveBeenCalledWith(unrelated);
    expect(loaded.abort).not.toHaveBeenCalled();
  });

  it.each(['active', 'pending'])('aborts only the %s occurrence when another turn shares its session', async (target) => {
    const loaded = new FakePiRuntime();
    const activeTurn = deferred();
    const activeTurnStarted = deferred();
    loaded.runTurn = mock(() => {
      activeTurnStarted.resolve();
      return activeTurn.promise;
    });
    const active = turnRequest();
    const successor = turnRequest();
    loaded.abort = mock(async (id, publish) => id === active.agentSessionId && publish === active.operation.publish);
    const runtime = new LazyPiRuntime(async () => loaded);
    await runtime.startSession(startRequest());

    const runningTurn = runtime.runTurn(active);
    await activeTurnStarted.promise;
    const queuedTurn = runtime.runTurn(successor);
    const turnResults = Promise.allSettled([runningTurn, queuedTurn]);

    const publish = target === 'active' ? active.operation.publish : successor.operation.publish;
    const abortResult = runtime.abort('pi-session', publish);
    expect(abortResult).toBeInstanceOf(Promise);
    await expect(abortResult).resolves.toBe(true);
    expect(loaded.abort).toHaveBeenCalledWith('pi-session', publish);
    activeTurn.resolve();

    const results = await turnResults;
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', target === 'pending' ? 'rejected' : 'fulfilled']);
    if (target === 'pending') expect(results[1].reason).toMatchObject({ name: 'AbortError' });
    expect(loaded.runTurn).toHaveBeenCalledTimes(target === 'pending' ? 1 : 2);
  });

  it('shuts down a deferred runtime without starting queued operations', async () => {
    const loaded = new FakePiRuntime();
    const stopped = deferred();
    loaded.shutdown = mock(() => stopped.promise);
    const loader = deferred();
    const runtime = new LazyPiRuntime(() => loader.promise);
    const start = runtime.startSession(startRequest());
    const turn = runtime.runTurn(turnRequest());

    const shutdown = runtime.shutdown();
    expect(runtime.shutdown()).toBe(shutdown);
    loader.resolve(loaded);

    const results = await Promise.allSettled([start, turn]);
    let shutdownSettled = false;
    void shutdown.then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    stopped.resolve();
    await shutdown;
    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    expect(loaded.shutdown).toHaveBeenCalledTimes(1);
    expect(loaded.startSession).not.toHaveBeenCalled();
    expect(loaded.runTurn).not.toHaveBeenCalled();
    await expect(runtime.startSession(startRequest())).rejects.toMatchObject({ name: 'AbortError' });
  });
});
