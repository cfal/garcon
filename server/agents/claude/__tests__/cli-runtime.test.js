import { describe, expect, it, mock } from 'bun:test';

mock.module('../../../config.js', () => ({
  getClaudeBinary: mock(() => 'claude'),
}));

mock.module('../cli-version.js', () => ({
  claudeCliSupportsLegacyThinkingFlag: mock(() => Promise.resolve(false)),
}));

import { ClaudeCliRuntime } from '../claude-cli.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createFakeClaudeProcess() {
  let stdoutController;
  const exited = deferred();
  const proc = {
    killed: false,
    stdin: {
      write: mock(() => undefined),
      flush: mock(() => undefined),
    },
    stdout: new ReadableStream({
      start(controller) {
        stdoutController = controller;
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: exited.promise,
    kill: mock(() => {
      proc.killed = true;
      stdoutController.close();
      exited.resolve(143);
    }),
  };

  return { proc, stdout: stdoutController };
}

describe('ClaudeCliRuntime stdout protocol handling', () => {
  it('fails and kills the process when init reports an unexpected session id', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = new ClaudeCliRuntime();
      const processing = [];
      runtime.onProcessing((chatId, isProcessing) => {
        processing.push({ chatId, isProcessing });
      });
      const failed = new Promise((resolve) => {
        runtime.onFailed((chatId, errorMessage) => resolve({ chatId, errorMessage }));
      });

      const start = runtime.startClaudeCliSession({
        command: 'hello',
        agentSessionId: 'expected-session',
        chatId: 'chat-1',
        projectPath: '/tmp',
        model: 'sonnet',
        permissionMode: 'default',
        thinkingMode: 'none',
      });
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'wrong-session',
      }) + '\n'));

      await expect(start).resolves.toBe('expected-session');
      await expect(failed).resolves.toEqual({
        chatId: 'chat-1',
        errorMessage: 'Unexpected Claude session ID: wrong-session',
      });
      expect(fake.proc.kill).toHaveBeenCalledTimes(1);
      expect(processing).toContainEqual({ chatId: 'chat-1', isProcessing: true });
      expect(processing).toContainEqual({ chatId: 'chat-1', isProcessing: false });
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});

