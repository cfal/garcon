import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { PiProvider } from '../pi-cli.js';

const originalSpawn = Bun.spawn;
const originalEnv = { ...process.env };
let tempRoot;

function createFakeProc() {
  const encoder = new TextEncoder();
  let stdoutController;
  let stderrController;
  let resolveExited;
  let closed = false;
  const writes = [];

  const stdout = new ReadableStream({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream({
    start(controller) {
      stderrController = controller;
    },
  });

  return {
    stdout,
    stderr,
    stdin: {
      writes,
      write(chunk) {
        writes.push(chunk);
      },
      end() { },
    },
    killed: false,
    exited: new Promise((resolve) => {
      resolveExited = resolve;
    }),
    pushJson(message) {
      stdoutController.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    },
    pushStderr(text) {
      stderrController.enqueue(encoder.encode(text));
    },
    close(exitCode = 0) {
      if (closed) return;
      closed = true;
      stdoutController.close();
      stderrController.close();
      resolveExited(exitCode);
    },
    kill() {
      this.killed = true;
      this.close(143);
    },
  };
}

function baseStartRequest(overrides = {}) {
  return {
    command: 'hello',
    chatId: 'chat-1',
    projectPath: path.join(tempRoot, 'project'),
    model: 'github-copilot/gpt-5.4',
    permissionMode: 'default',
    thinkingMode: 'none',
    ...overrides,
  };
}

function baseResumeRequest(overrides = {}) {
  return {
    ...baseStartRequest({ chatId: 'chat-2', command: 'continue' }),
    providerSessionId: 'pi-session-2',
    nativePath: path.join(tempRoot, 'pi-session-2.jsonl'),
    ...overrides,
  };
}

function sessionHeader(id = 'pi-session-1') {
  return {
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: path.join(tempRoot, 'project'),
  };
}

describe('PiProvider lifecycle', () => {
  let spawnMock;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-pi-provider-'));
    await fs.mkdir(path.join(tempRoot, 'project'), { recursive: true });
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tempRoot, 'sessions');
    process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, 'agent');
    spawnMock = mock();
    Bun.spawn = spawnMock;
  });

  afterEach(async () => {
    Bun.spawn = originalSpawn;
    process.env = { ...originalEnv };
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('resolves startSession from the Pi JSON session header', async () => {
    const provider = new PiProvider();
    const processing = mock();
    const created = mock();
    provider.onProcessing(processing);
    provider.onSessionCreated(created);

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const startedPromise = provider.startSession(baseStartRequest());
    proc.pushJson(sessionHeader('pi-session-1'));

    const started = await startedPromise;

    expect(started.providerSessionId).toBe('pi-session-1');
    expect(started.nativePath).toBe(path.join(
      process.env.PI_CODING_AGENT_SESSION_DIR,
      '2026-01-01T00-00-00-000Z_pi-session-1.jsonl',
    ));
    expect(processing).toHaveBeenCalledWith('chat-1', true);
    expect(created).toHaveBeenCalledWith('chat-1');
    expect(proc.stdin.writes.join('')).toBe('hello');
    expect(spawnMock.mock.calls[0][0]).toEqual(expect.arrayContaining(['--mode', 'json', '--session-dir']));
    expect(spawnMock.mock.calls[0][0]).toEqual(expect.arrayContaining(['--model', 'github-copilot/gpt-5.4']));

    proc.pushJson({ type: 'agent_end' });
    proc.close(0);
  });

  it('continues an existing session using the native session path', async () => {
    const nativePath = path.join(tempRoot, 'pi-session-2.jsonl');
    await fs.writeFile(nativePath, '{}\n', 'utf8');
    const provider = new PiProvider();
    const messages = mock();
    const finished = mock();
    provider.onMessages(messages);
    provider.onFinished(finished);

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn(baseResumeRequest({ nativePath }));
    proc.pushJson(sessionHeader('pi-session-2'));
    proc.pushJson({
      type: 'message_end',
      message: {
        role: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        content: [{ type: 'text', text: 'Pi reply' }],
      },
    });
    proc.pushJson({ type: 'agent_end' });
    proc.close(0);

    await turnPromise;

    const args = spawnMock.mock.calls[0][0];
    expect(args[args.indexOf('--session') + 1]).toBe(nativePath);
    expect(messages).toHaveBeenCalledWith('chat-2', [
      expect.objectContaining({ type: 'assistant-message', content: 'Pi reply' }),
    ]);
    expect(finished).toHaveBeenCalledWith('chat-2', 0);
    expect(provider.isRunning('pi-session-2')).toBe(false);
  });

  it('emits tool-use and tool-result events from Pi JSON stream events', async () => {
    const nativePath = path.join(tempRoot, 'pi-session-tools.jsonl');
    await fs.writeFile(nativePath, '{}\n', 'utf8');
    const provider = new PiProvider();
    const messages = mock();
    provider.onMessages(messages);

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn(baseResumeRequest({
      providerSessionId: 'pi-session-tools',
      nativePath,
      permissionMode: 'plan',
    }));
    proc.pushJson(sessionHeader('pi-session-tools'));
    proc.pushJson({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    proc.pushJson({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      result: { content: { stdout: '/tmp/project' } },
      isError: false,
    });
    proc.pushJson({ type: 'agent_end' });
    proc.close(0);

    await turnPromise;

    const args = spawnMock.mock.calls[0][0];
    expect(args[args.indexOf('--tools') + 1]).toBe('read,grep,find,ls');
    expect(proc.stdin.writes.join('')).toContain('Garcon plan mode');
    expect(messages.mock.calls[0][1][0]).toMatchObject({
      type: 'bash-tool-use',
      toolId: 'tool-1',
      command: 'pwd',
    });
    expect(messages.mock.calls[1][1][0]).toMatchObject({
      type: 'tool-result',
      toolId: 'tool-1',
      content: { stdout: '/tmp/project' },
      isError: false,
    });
  });

  it('rejects startSession when the process exits before a session header', async () => {
    const provider = new PiProvider();
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const startedPromise = provider.startSession(baseStartRequest());
    proc.close(7);

    await expect(startedPromise).rejects.toThrow('Pi process exited before session header (code 7)');
  });

  it('rejects Pi default because Pi runs require an explicit model', async () => {
    const provider = new PiProvider();

    await expect(provider.startSession(baseStartRequest({ model: 'default' })))
      .rejects.toThrow('Pi requires an explicit model selection.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('aborts a running Pi process', async () => {
    const provider = new PiProvider();
    const processing = mock();
    provider.onProcessing(processing);
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const startedPromise = provider.startSession(baseStartRequest());
    proc.pushJson(sessionHeader('pi-session-abort'));
    await startedPromise;

    expect(provider.abort('pi-session-abort')).toBe(true);
    expect(proc.killed).toBe(true);
    expect(processing).toHaveBeenLastCalledWith('chat-1', false);
  });
});
