import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { CursorProvider, runSingleQuery } from '../cursor-cli.js';

function createFakeProc() {
  const encoder = new TextEncoder();
  let stdoutController;
  let resolveExited;
  let closed = false;

  const stdout = new ReadableStream({
    start(controller) {
      stdoutController = controller;
    },
  });

  const stderr = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  const proc = {
    stdout,
    stderr,
    killed: false,
    exited: new Promise((resolve) => {
      resolveExited = resolve;
    }),
    pushJson(message) {
      stdoutController.enqueue(encoder.encode(JSON.stringify(message) + '\n'));
    },
    close(exitCode = 0) {
      if (closed) return;
      closed = true;
      stdoutController.close();
      resolveExited(exitCode);
    },
    kill() {
      this.killed = true;
      this.close(143);
    },
  };

  return proc;
}

function createCommandProc(stdoutText, exitCode = 0) {
  const encoder = new TextEncoder();
  const streamFor = (text) => new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

  return {
    stdout: streamFor(stdoutText),
    stderr: streamFor(''),
    exited: Promise.resolve(exitCode),
  };
}

describe('CursorProvider lifecycle', () => {
  let originalSpawn;
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  it('resolves startSession on system init and requests Cursor stream JSON', async () => {
    const provider = new CursorProvider();
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const startedPromise = provider.startSession({
      command: 'hello cursor',
      chatId: 'chat-1',
      projectPath: '/proj',
      model: 'gpt-5.3-codex',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    expect(spawnMock.mock.calls[0][0].slice(1)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--workspace',
      '/proj',
      '--trust',
      '--model',
      'gpt-5.3-codex',
      'hello cursor',
    ]);

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'cursor-session-1',
    });

    await expect(startedPromise).resolves.toEqual({
      providerSessionId: 'cursor-session-1',
      nativePath: '!cursor:cursor-session-1',
    });

    proc.pushJson({ type: 'result', subtype: 'success', session_id: 'cursor-session-1' });
    proc.close(0);
  });

  it('continues a session, deduplicates tool calls, and emits tool results', async () => {
    const provider = new CursorProvider();
    const messages = mock();
    provider.onMessages(messages);

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'continue',
      providerSessionId: 'cursor-session-2',
      chatId: 'chat-2',
      projectPath: '/proj',
      model: 'gpt-5.3-codex',
      permissionMode: 'acceptEdits',
      thinkingMode: 'none',
    });

    expect(spawnMock.mock.calls[0][0].slice(1)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--workspace',
      '/proj',
      '--trust',
      '--resume',
      'cursor-session-2',
      '--force',
      'continue',
    ]);

    proc.pushJson({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'checking' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          { type: 'text', text: 'done' },
        ],
      },
    });
    proc.pushJson({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tool-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      result: { stdout: '/proj' },
    });
    proc.pushJson({ type: 'result', subtype: 'success', session_id: 'cursor-session-2' });
    proc.close(0);

    await turnPromise;

    const emitted = messages.mock.calls.flatMap((call) => call[1]);
    expect(emitted.map((message) => message.type)).toEqual([
      'thinking',
      'bash-tool-use',
      'assistant-message',
      'tool-result',
    ]);
    expect(emitted.filter((message) => message.type === 'bash-tool-use')).toHaveLength(1);
    expect(emitted.find((message) => message.type === 'tool-result')?.content).toEqual({ stdout: '/proj' });
  });

  it('runs one-shot prompts with print JSON mode', async () => {
    spawnMock.mockReturnValueOnce(createCommandProc(JSON.stringify({ result: 'one-shot result' })));

    await expect(runSingleQuery('say hi', {
      cwd: '/proj',
      model: 'gpt-5.3-codex',
    })).resolves.toBe('one-shot result');

    expect(spawnMock.mock.calls[0][0].slice(1)).toEqual([
      '--print',
      '--output-format',
      'json',
      '--mode',
      'ask',
      '--workspace',
      '/proj',
      '--trust',
      '--model',
      'gpt-5.3-codex',
      'say hi',
    ]);
  });
});
