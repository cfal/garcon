import { beforeEach, describe, expect, it, mock } from 'bun:test';

const spawnedPtys = [];
const sendWebSocketJson = mock(() => undefined);

mock.module('bun-pty', () => ({
  spawn: mock(() => {
    const callbacks = {
      data: null,
      exit: null,
    };
    const pty = {
      pid: 1234,
      kill: mock(() => undefined),
      write: mock(() => undefined),
      resize: mock(() => undefined),
      onData: mock((callback) => {
        callbacks.data = callback;
      }),
      onExit: mock((callback) => {
        callbacks.exit = callback;
      }),
      emitData(chunk) {
        callbacks.data?.(chunk);
      },
      emitExit(exitCode = { exitCode: 0, signal: null }) {
        callbacks.exit?.(exitCode);
      },
    };
    spawnedPtys.push(pty);
    return pty;
  }),
}));

mock.module('../utils.js', () => ({
  sendWebSocketJson,
}));

mock.module('../../config.js', () => ({
  getUserShell: () => '/bin/sh',
}));

import { ShellManager } from '../shell.js';

function createWs() {
  return { data: {} };
}

beforeEach(() => {
  spawnedPtys.length = 0;
  sendWebSocketJson.mockClear();
});

describe('ShellManager shutdown', () => {
  it('kills active PTY sessions', async () => {
    const manager = new ShellManager();
    const handler = manager.createHandler();
    const ws = createWs();

    handler.open(ws);
    await handler.message(ws, {
      type: 'init',
      projectPath: '/tmp',
      chatId: 'chat-1',
      sessionPolicy: 'reuse',
    });
    manager.shutdown();

    expect(spawnedPtys).toHaveLength(1);
    expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(1);
  });

  it('clears reconnect timeouts before killing detached PTY sessions', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timeoutId = { unref: mock(() => undefined) };
    const clearTimeout = mock(() => undefined);
    globalThis.setTimeout = mock(() => timeoutId);
    globalThis.clearTimeout = clearTimeout;

    try {
      const manager = new ShellManager();
      const handler = manager.createHandler();
      const ws = createWs();

      handler.open(ws);
      await handler.message(ws, {
        type: 'init',
        projectPath: '/tmp',
        chatId: 'chat-1',
        sessionPolicy: 'reuse',
      });
      handler.close(ws, 1000, '');
      manager.shutdown();

      expect(timeoutId.unref).toHaveBeenCalledTimes(1);
      expect(clearTimeout).toHaveBeenCalledWith(timeoutId);
      expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
