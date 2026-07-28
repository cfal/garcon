import { describe, expect, it, mock } from 'bun:test';

import { ClaudeControlBroker } from '../cli-control.js';

function requestId(write) {
  return JSON.parse(write.mock.calls.at(-1)[1]).request_id;
}

describe('ClaudeControlBroker', () => {
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
