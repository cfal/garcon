import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { runSingleQuery } from '../cursor/run-single-query.js';

function createFakeAcpProc() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const requests = [];
  let stdoutController;
  let resolveExited;
  let stdinBuffer = '';
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
    stdin: {
      write(chunk) {
        stdinBuffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk);
        const lines = stdinBuffer.split('\n');
        stdinBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) handleRequest(JSON.parse(line));
        }
      },
      end() {},
    },
    killed: false,
    exited: new Promise((resolve) => {
      resolveExited = resolve;
    }),
    requests,
    kill() {
      this.killed = true;
      this.close(143);
    },
    close(exitCode = 0) {
      if (closed) return;
      closed = true;
      stdoutController.close();
      resolveExited(exitCode);
    },
  };

  function send(message) {
    queueMicrotask(() => {
      if (!closed) stdoutController.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    });
  }

  function respond(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function handleRequest(message) {
    requests.push(message);
    if (message.method === 'initialize') {
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'cursor_login' }],
      });
      return;
    }
    if (message.method === 'authenticate') {
      respond(message.id, {});
      return;
    }
    if (message.method === 'session/new') {
      respond(message.id, { sessionId: 'cursor-acp-session-1' });
      return;
    }
    if (message.method === 'session/prompt') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'cursor-acp-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'one-shot ' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'cursor-acp-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'result' },
          },
        },
      });
      respond(message.id, { stopReason: 'end_turn' });
    }
  }

  return proc;
}

describe('Cursor ACP runSingleQuery', () => {
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

  it('runs one-shot prompts through Cursor ACP ask mode', async () => {
    const proc = createFakeAcpProc();
    spawnMock.mockReturnValueOnce(proc);

    await expect(runSingleQuery('say hi', {
      cwd: '/proj',
      model: 'gpt-5.3-codex',
    })).resolves.toBe('one-shot result');

    expect(spawnMock.mock.calls[0][0].slice(1)).toEqual(['acp']);
    expect(proc.requests.map((request) => request.method)).toEqual([
      'initialize',
      'authenticate',
      'notifications/initialized',
      'session/new',
      'session/prompt',
    ]);

    const newSession = proc.requests.find((request) => request.method === 'session/new');
    expect(newSession.params).toMatchObject({
      cwd: '/proj',
      mcpServers: [],
      model: 'gpt-5.3-codex',
    });

    const prompt = proc.requests.find((request) => request.method === 'session/prompt');
    expect(prompt.params).toMatchObject({
      sessionId: 'cursor-acp-session-1',
      prompt: [{ type: 'text', text: 'say hi' }],
      config: {
        mode: 'ask',
        model: 'gpt-5.3-codex',
      },
    });
    expect(proc.killed).toBe(true);
  });
});
