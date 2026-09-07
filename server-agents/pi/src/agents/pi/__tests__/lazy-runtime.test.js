import { describe, expect, it, mock } from 'bun:test';
import { LazyPiRuntime } from '../lazy-runtime.ts';

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
    expect(runtime.abort('pi-session')).toBe(false);
    expect(runtime.captureSteerTarget('pi-session')).toBeNull();
    expect(loadRuntime).not.toHaveBeenCalled();

    await runtime.startSession({});

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
    const startRequest = { operation: startOperation };
    const turnRequest = { agentSessionId: 'pi-session', operation: turnOperation };

    await Promise.all([runtime.startSession(startRequest), runtime.runTurn(turnRequest)]);

    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(loaded.startSession).toHaveBeenCalledWith(startRequest);
    expect(loaded.runTurn).toHaveBeenCalledWith(turnRequest);
  });

  it('cancels only the matching queued turn when aborted during loading', async () => {
    const loaded = new FakePiRuntime();
    const loader = deferred();
    const runtime = new LazyPiRuntime(() => loader.promise);
    const start = runtime.startSession({});
    const turn = runtime.runTurn({ agentSessionId: 'pi-session' });
    const unrelatedTurn = runtime.runTurn({ agentSessionId: 'other-session' });

    expect(runtime.abort('pi-session')).toBe(true);
    expect(runtime.abort('missing-session')).toBe(false);
    loader.resolve(loaded);

    const results = await Promise.allSettled([start, turn, unrelatedTurn]);
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results[1].reason).toMatchObject({ name: 'AbortError' });
    expect(loaded.startSession).toHaveBeenCalledTimes(1);
    expect(loaded.runTurn).toHaveBeenCalledTimes(1);
    expect(loaded.runTurn).toHaveBeenCalledWith({ agentSessionId: 'other-session' });
    expect(loaded.abort).not.toHaveBeenCalled();
  });

  it('aborts an active runtime turn while cancelling a matching queued turn', async () => {
    const loaded = new FakePiRuntime();
    const activeTurn = deferred();
    const activeTurnStarted = deferred();
    loaded.runTurn = mock(() => {
      activeTurnStarted.resolve();
      return activeTurn.promise;
    });
    loaded.abort = mock(async () => false);
    const runtime = new LazyPiRuntime(async () => loaded);
    await runtime.startSession({});

    const runningTurn = runtime.runTurn({ agentSessionId: 'pi-session' });
    await activeTurnStarted.promise;
    const queuedTurn = runtime.runTurn({ agentSessionId: 'pi-session' });
    const turnResults = Promise.allSettled([runningTurn, queuedTurn]);

    const abortResult = runtime.abort('pi-session');
    expect(abortResult).toBeInstanceOf(Promise);
    await expect(abortResult).resolves.toBe(true);
    expect(loaded.abort).toHaveBeenCalledWith('pi-session');
    activeTurn.resolve();

    const results = await turnResults;
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason).toMatchObject({ name: 'AbortError' });
    expect(loaded.runTurn).toHaveBeenCalledTimes(1);
  });

  it('shuts down a deferred runtime without starting queued operations', async () => {
    const loaded = new FakePiRuntime();
    const stopped = deferred();
    loaded.shutdown = mock(() => stopped.promise);
    const loader = deferred();
    const runtime = new LazyPiRuntime(() => loader.promise);
    const start = runtime.startSession({});
    const turn = runtime.runTurn({});

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
    await expect(runtime.startSession({})).rejects.toMatchObject({ name: 'AbortError' });
  });
});
