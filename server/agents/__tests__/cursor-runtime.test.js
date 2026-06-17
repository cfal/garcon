import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { CursorRuntime, runSingleQuery } from '../cursor/cursor-cli.js';

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

describe('CursorRuntime lifecycle', () => {
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
    const provider = new CursorRuntime();
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
      agentSessionId: 'cursor-session-1',
      nativePath: '!cursor-stream-json:cursor-session-1',
    });

    proc.pushJson({ type: 'result', subtype: 'success', session_id: 'cursor-session-1' });
    proc.close(0);
  });

  it('continues a session, deduplicates tool calls, and emits tool results', async () => {
    const provider = new CursorRuntime();
    const messages = mock();
    const finished = mock();
    let runningWhenFinished;
    provider.onMessages(messages);
    provider.onFinished((chatId, exitCode, metadata) => {
      runningWhenFinished = provider.isRunning('cursor-session-2');
      finished(chatId, exitCode, metadata);
    });

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'continue',
      agentSessionId: 'cursor-session-2',
      chatId: 'chat-2',
      projectPath: '/proj',
      model: 'gpt-5.3-codex',
      permissionMode: 'acceptEdits',
      thinkingMode: 'none',
      clientRequestId: 'req-2',
      turnId: 'turn-2',
    });

    expect(spawnMock.mock.calls[0][0].slice(1)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--workspace',
      '/proj',
      '--trust',
      '--resume',
      'cursor-session-2',
      '--force',
      'continue',
    ]);

    proc.pushJson({
      type: 'user',
      session_id: 'cursor-session-2',
      message: { role: 'user', content: 'continue' },
    });
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
    proc.pushJson({
      type: 'result',
      subtype: 'success',
      session_id: 'cursor-session-2',
      request_id: 'cursor-req-2',
    });
    proc.close(0);

    await turnPromise;

    const emitted = messages.mock.calls.flatMap((call) => call[1]);
    expect(emitted.map((message) => message.type)).toEqual([
      'thinking',
      'bash-tool-use',
      'assistant-message',
      'tool-result',
    ]);
    expect(finished).toHaveBeenCalledWith('chat-2', 0, { upstreamRequestId: 'cursor-req-2' });
    expect(runningWhenFinished).toBe(false);
    expect(emitted.filter((message) => message.type === 'bash-tool-use')).toHaveLength(1);
    expect(emitted.find((message) => message.type === 'tool-result')?.content).toEqual({ stdout: '/proj' });
  });

  it('normalizes live Cursor Glob results to canonical file lists', async () => {
    const provider = new CursorRuntime();
    const messages = mock();
    provider.onMessages(messages);

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'find daml files',
      agentSessionId: 'cursor-session-3',
      chatId: 'chat-3',
      projectPath: '/proj',
      model: 'kimi-k2.5',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'functions.Glob:0',
      toolName: 'Glob',
      args: { glob_pattern: 'contracts/**/daml.yaml' },
      result: 'Result of search in "" (total 2 files):\n- ./contracts/a/daml.yaml\n- ./contracts/b/daml.yaml\n',
    });
    proc.pushJson({ type: 'result', subtype: 'success', session_id: 'cursor-session-3' });
    proc.close(0);

    await turnPromise;

    const emitted = messages.mock.calls.flatMap((call) => call[1]);
    expect(emitted.find((message) => message.type === 'glob-tool-use')?.pattern)
      .toBe('contracts/**/daml.yaml');
    expect(emitted.find((message) => message.type === 'tool-result')?.content).toEqual({
      filenames: ['./contracts/a/daml.yaml', './contracts/b/daml.yaml'],
      numFiles: 2,
    });
  });

  it('normalizes wrapped stream-json Read and Grep tool metadata', async () => {
    const provider = new CursorRuntime();
    const messages = mock();
    provider.onMessages(messages);

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'inspect cursor tools',
      agentSessionId: 'cursor-session-4',
      chatId: 'chat-4',
      projectPath: '/repo',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool-read-1',
      tool_call: {
        readToolCall: {
          args: { path: '/repo/server/agents/cursor/tool-use-converter.ts' },
        },
        hookAdditionalContexts: [],
        toolCallId: 'tool-read-1',
      },
    });
    proc.pushJson({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool-grep-1',
      tool_call: {
        grepToolCall: {
          args: {
            pattern: 'convertCursorToolUse',
            path: '/repo/server/agents/cursor',
            caseInsensitive: false,
            multiline: false,
            toolCallId: 'tool-grep-1',
            offset: 0,
          },
        },
        hookAdditionalContexts: [],
        toolCallId: 'tool-grep-1',
      },
    });
    proc.pushJson({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tool-read-1',
      tool_call: {
        readToolCall: {
          args: { path: '/repo/server/agents/cursor/tool-use-converter.ts' },
          result: {
            success: {
              content: 'export function convertCursorToolUse() {}\n',
              totalLines: 1,
              fileSize: 43,
              path: '/repo/server/agents/cursor/tool-use-converter.ts',
              readRange: { startLine: 1, endLine: 1 },
            },
          },
        },
        hookAdditionalContexts: [],
        toolCallId: 'tool-read-1',
      },
    });
    proc.pushJson({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tool-grep-1',
      tool_call: {
        grepToolCall: {
          args: {
            pattern: 'convertCursorToolUse',
            path: '/repo/server/agents/cursor',
            caseInsensitive: false,
            multiline: false,
            toolCallId: 'tool-grep-1',
            offset: 0,
          },
          result: {
            success: {
              pattern: 'convertCursorToolUse',
              path: '/repo/server/agents/cursor',
              outputMode: 'content',
              workspaceResults: {
                '/repo': {
                  content: {
                    matches: [
                      {
                        file: 'server/agents/cursor/tool-use-converter.ts',
                        matches: [
                          {
                            lineNumber: 158,
                            content: 'export function convertCursorToolUse() {}',
                            contentTruncated: false,
                            isContextLine: false,
                          },
                        ],
                      },
                      {
                        file: 'server/agents/cursor/cursor-cli.ts',
                        matches: [
                          {
                            lineNumber: 439,
                            content: 'convertCursorToolUse(timestamp, event)',
                            contentTruncated: false,
                            isContextLine: false,
                          },
                        ],
                      },
                    ],
                    totalLines: 2,
                    totalMatchedLines: 2,
                    clientTruncated: false,
                    ripgrepTruncated: false,
                  },
                },
              },
            },
          },
        },
        hookAdditionalContexts: [],
        toolCallId: 'tool-grep-1',
      },
    });
    proc.pushJson({ type: 'result', subtype: 'success', session_id: 'cursor-session-4' });
    proc.close(0);

    await turnPromise;

    const emitted = messages.mock.calls.flatMap((call) => call[1]);
    expect(emitted.map((message) => message.type)).toEqual([
      'read-tool-use',
      'grep-tool-use',
      'tool-result',
      'tool-result',
    ]);
    expect(emitted[0].filePath).toBe('/repo/server/agents/cursor/tool-use-converter.ts');
    expect(emitted[1].pattern).toBe('convertCursorToolUse');
    expect(emitted[1].path).toBe('/repo/server/agents/cursor');
    expect(emitted[2].content).toEqual({
      content: 'export function convertCursorToolUse() {}\n',
      totalLines: 1,
      fileSize: 43,
      path: '/repo/server/agents/cursor/tool-use-converter.ts',
      readRange: { startLine: 1, endLine: 1 },
    });
    expect(emitted[3].content).toEqual({
      filenames: [
        'server/agents/cursor/tool-use-converter.ts',
        'server/agents/cursor/cursor-cli.ts',
      ],
      numFiles: 2,
      totalMatches: 2,
      matches: [
        {
          file: 'server/agents/cursor/tool-use-converter.ts',
          matches: [
            {
              lineNumber: 158,
              content: 'export function convertCursorToolUse() {}',
              contentTruncated: false,
              isContextLine: false,
            },
          ],
        },
        {
          file: 'server/agents/cursor/cursor-cli.ts',
          matches: [
            {
              lineNumber: 439,
              content: 'convertCursorToolUse(timestamp, event)',
              contentTruncated: false,
              isContextLine: false,
            },
          ],
        },
      ],
      pattern: 'convertCursorToolUse',
      path: '/repo/server/agents/cursor',
    });
  });

  it('marks Cursor sessions idle before emitting failed from error events', async () => {
    const provider = new CursorRuntime();
    const failed = mock();
    let runningWhenFailed;
    provider.onFailed((chatId, message) => {
      runningWhenFailed = provider.isRunning('cursor-session-error');
      failed(chatId, message);
    });

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'continue',
      agentSessionId: 'cursor-session-error',
      chatId: 'chat-error',
      projectPath: '/proj',
      model: 'gpt-5.3-codex',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'error',
      session_id: 'cursor-session-error',
      message: 'cursor failed',
    });
    proc.close(1);

    await turnPromise;

    expect(failed).toHaveBeenCalledWith('chat-error', 'cursor failed');
    expect(runningWhenFailed).toBe(false);
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
