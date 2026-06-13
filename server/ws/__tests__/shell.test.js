import { beforeEach, describe, expect, it, mock } from 'bun:test';

const spawnedPtys = [];
const sendWebSocketJson = mock(() => undefined);
const testBasePath = '/tmp';

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
  getProjectBasePath: () => testBasePath,
}));

import { ShellManager } from '../shell.js';

function createWs() {
  return { data: {}, close: mock(() => undefined) };
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

  it('kills fresh PTY sessions immediately on close', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = mock(() => ({ unref: mock(() => undefined) }));

    try {
      const manager = new ShellManager();
      const handler = manager.createHandler();
      const ws = createWs();

      handler.open(ws);
      await handler.message(ws, {
        type: 'init',
        projectPath: '/tmp',
        chatId: 'chat-1',
        sessionPolicy: 'fresh',
      });
      handler.close(ws, 1000, '');

      expect(spawnedPtys).toHaveLength(1);
      expect(spawnedPtys[0].kill).toHaveBeenCalledTimes(1);
      expect(globalThis.setTimeout).not.toHaveBeenCalled();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('routes input through the current attached session socket', async () => {
    const manager = new ShellManager();
    const handler = manager.createHandler();
    const firstWs = createWs();
    const secondWs = createWs();

    handler.open(firstWs);
    await handler.message(firstWs, {
      type: 'init',
      projectPath: '/tmp',
      chatId: 'chat-1',
      sessionPolicy: 'reuse',
    });
    handler.open(secondWs);
    await handler.message(secondWs, {
      type: 'init',
      projectPath: '/tmp',
      chatId: 'chat-1',
      sessionPolicy: 'reuse',
    });

    spawnedPtys[0].write.mockClear();
    await handler.message(firstWs, { type: 'input', data: 'old socket\n' });
    expect(spawnedPtys[0].write).not.toHaveBeenCalled();

    await handler.message(secondWs, { type: 'input', data: 'current socket\n' });
    expect(spawnedPtys[0].write).toHaveBeenCalledWith('current socket\n');
  });

  it('replays buffered output as one byte-capped payload on reconnect', async () => {
    const manager = new ShellManager();
    const handler = manager.createHandler();
    const firstWs = createWs();
    const secondWs = createWs();

    handler.open(firstWs);
    await handler.message(firstWs, {
      type: 'init',
      projectPath: '/tmp',
      chatId: 'chat-1',
      sessionPolicy: 'reuse',
    });
    spawnedPtys[0].emitData('a'.repeat(700 * 1024));
    spawnedPtys[0].emitData('b'.repeat(700 * 1024));
    handler.close(firstWs, 1000, '');

    sendWebSocketJson.mockClear();
    handler.open(secondWs);
    await handler.message(secondWs, {
      type: 'init',
      projectPath: '/tmp',
      chatId: 'chat-1',
      sessionPolicy: 'reuse',
    });

    const outputPayloads = sendWebSocketJson.mock.calls
      .map((call) => call[1])
      .filter((payload) => payload.type === 'output');
    expect(outputPayloads).toHaveLength(2);
    expect(outputPayloads[0].data).toContain('Reconnected to existing session');
    expect(outputPayloads[1].data.length).toBeLessThanOrEqual(1024 * 1024);
    expect(outputPayloads[1].data).toBe('b'.repeat(700 * 1024));
  });

  it('rejects init requests outside the configured project base', async () => {
    const manager = new ShellManager();
    const handler = manager.createHandler();
    const ws = createWs();

    handler.open(ws);
    await handler.message(ws, {
      type: 'init',
      projectPath: '/',
      chatId: 'chat-1',
      sessionPolicy: 'reuse',
    });

    expect(spawnedPtys).toHaveLength(0);
    expect(ws.close).toHaveBeenCalledWith(1008, 'outside_project_base');
    expect(sendWebSocketJson).toHaveBeenCalledWith(ws, expect.objectContaining({
      type: 'output',
    }));
  });

  it('rejects malformed shell messages without spawning a PTY', async () => {
    const manager = new ShellManager();
    const handler = manager.createHandler();
    const ws = createWs();

    handler.open(ws);
    await handler.message(ws, {
      type: 'resize',
      cols: 0,
      rows: 24,
    });

    expect(spawnedPtys).toHaveLength(0);
    expect(sendWebSocketJson).toHaveBeenCalledWith(ws, {
      type: 'error',
      message: 'Invalid shell message',
    });
  });

  it('does not print a Claude resume command for Garcon chat ids', async () => {
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

    const outputPayloads = sendWebSocketJson.mock.calls
      .map((call) => call[1])
      .filter((payload) => payload.type === 'output');
    expect(outputPayloads.map((payload) => payload.data).join('\n')).not.toContain('claude --resume');
  });
});
