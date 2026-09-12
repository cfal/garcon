import { describe, expect, it, mock } from 'bun:test';

import { ClaudeControlBroker } from '../cli-control.js';

function requestId(write) {
  return JSON.parse(write.mock.calls.at(-1)[1]).request_id;
}

describe('ClaudeControlBroker', () => {
  it('holds a timed-out request until its native write settles', async () => {
    const nativeWrite = Promise.withResolvers();
    const timedOut = Promise.withResolvers();
    const originalSetTimeout = globalThis.setTimeout;
    const write = mock(() => nativeWrite.promise);
    const broker = new ClaudeControlBroker(write);
    let settled = false;
    try {
      globalThis.setTimeout = (callback, duration) => originalSetTimeout(() => {
        callback();
        timedOut.resolve();
      }, duration);
      const pending = broker.request('session-1', { subtype: 'set_permission_mode' }, { timeoutMs: 1 });
      const result = pending.then(() => 'applied', error => error.message).finally(() => { settled = true; });
      await timedOut.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      nativeWrite.resolve();
      expect(await result).toContain('timed out');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      nativeWrite.resolve();
      broker.shutdown('test complete');
    }
  });

  it('checks a queued write at delivery and preserves a confirmed reply through late cancellation', async () => {
    const gate = Promise.withResolvers();
    const attempted = mock(() => undefined);
    const write = mock(async (_id, _line, beforeWrite) => {
      await gate.promise;
      beforeWrite();
      attempted();
    });
    const broker = new ClaudeControlBroker(write);
    const controller = new AbortController();
    const pending = broker.request('session-1', { subtype: 'set_permission_mode' }, { signal: controller.signal });
    controller.abort();
    gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(attempted).not.toHaveBeenCalled();

    const flush = Promise.withResolvers();
    write.mockImplementation((_id, _line, beforeWrite) => { beforeWrite(); return flush.promise; });
    const confirmedController = new AbortController();
    const confirmed = broker.request('session-1', { subtype: 'set_permission_mode' }, { signal: confirmedController.signal });
    await Promise.resolve();
    broker.handleResponse('session-1', { type: 'control_response', response: {
      subtype: 'success', request_id: requestId(write), response: { accepted: true },
    } });
    confirmedController.abort();
    flush.resolve();
    expect(await confirmed).toEqual({ accepted: true });
  });

  it('correlates successful and failed control responses', async () => {
    const write = mock(() => Promise.resolve());
    const broker = new ClaudeControlBroker(write);

    const success = broker.request('session-1', { subtype: 'initialize' });
    await Promise.resolve();
    const successId = requestId(write);
    expect(broker.handleResponse('session-1', {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: successId,
        response: { commands: [] },
      },
    })).toBe(true);
    await expect(success).resolves.toEqual({ commands: [] });

    const failure = broker.request('session-1', { subtype: 'set_model' });
    await Promise.resolve();
    const failureId = requestId(write);
    expect(broker.handleResponse('session-1', {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: failureId,
        error: 'unsupported model',
      },
    })).toBe(true);
    await expect(failure).rejects.toThrow('unsupported model');
  });

  it('rejects timeouts, failed writes, process exits, and shutdown', async () => {
    const write = mock(() => Promise.resolve());
    const broker = new ClaudeControlBroker(write);

    await expect(broker.request('session-1', { subtype: 'slow' }, { timeoutMs: 1 }))
      .rejects.toThrow('Claude CLI slow control request timed out');

    const processExit = broker.request('session-1', { subtype: 'interrupt' });
    broker.rejectSession('session-1', 'process exited');
    await expect(processExit).rejects.toThrow('process exited');

    const shutdown = broker.request('session-2', { subtype: 'initialize' });
    broker.shutdown('runtime stopped');
    await expect(shutdown).rejects.toThrow('runtime stopped');

    const failedWrite = new ClaudeControlBroker(
      mock(() => Promise.reject(new Error('stdin failed'))),
    );
    await expect(failedWrite.request('session-1', { subtype: 'initialize' }))
      .rejects.toThrow('stdin failed');
  });

  it('does not let another session consume a response', async () => {
    const write = mock(() => Promise.resolve());
    const broker = new ClaudeControlBroker(write);
    const pending = broker.request('session-1', { subtype: 'initialize' });
    await Promise.resolve();
    const id = requestId(write);

    expect(broker.handleResponse('session-2', {
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response: {} },
    })).toBe(false);
    broker.rejectSession('session-1', 'test complete');
    await expect(pending).rejects.toThrow('test complete');
  });

  it('rejects a correlated response without an explicit success or error subtype', async () => {
    const write = mock(() => Promise.resolve());
    const broker = new ClaudeControlBroker(write);
    const pending = broker.request('session-1', { subtype: 'interrupt' });
    await Promise.resolve();
    const id = requestId(write);

    expect(broker.handleResponse('session-1', {
      type: 'control_response',
      response: { request_id: id, response: {} },
    })).toBe(true);
    await expect(pending).rejects.toThrow(
      'Claude CLI interrupt control request returned an invalid response',
    );
  });

  it('removes a cancelled request before a late response arrives', async () => {
    const write = mock(() => Promise.resolve());
    const broker = new ClaudeControlBroker(write);
    const controller = new AbortController();
    const pending = broker.request(
      'session-1',
      { subtype: 'interrupt' },
      { signal: controller.signal },
    );
    await Promise.resolve();
    const id = requestId(write);

    controller.abort(new Error('turn already cancelled'));
    await expect(pending).rejects.toThrow('turn already cancelled');
    expect(broker.handleResponse('session-1', {
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response: {} },
    })).toBe(false);
  });
});
