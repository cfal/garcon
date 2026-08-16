import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import { PiRpcRuntime } from '../pi-rpc-runtime.js';
import { testLogger, testModels, testPiConfig } from './test-fixtures.js';

// Unit coverage for the long-lived RPC runtime: spawn/ready handshake, reuse vs respawn,
// stop-as-kill, settle semantics, steering state machine, and generation fencing. The
// integration lane (tests/server/pi-*) covers the same behavior end to end against the real
// CLI; these tests pin the internal decisions that the wire protocol alone cannot show.

const originalSpawn = Bun.spawn;
const originalEnv = { ...process.env };
let tempRoot;

function createRuntime(options = {}) {
  return new PiRpcRuntime({
    config: testPiConfig,
    logger: testLogger,
    models: testModels,
    ...options,
  });
}

// A fake pi process speaking the RPC protocol. Commands get correlated responses driven by
// per-command handlers tests can reconfigure; events are pushed with pushEvent.
function createFakePiProcess(options = {}) {
  const encoder = new TextEncoder();
  let stdoutController;
  let stderrController;
  let resolveExited;
  let closed = false;
  const writes = [];
  const commands = [];
  const state = {
    sessionId: options.sessionId ?? 'pi-session-1',
    sessionFile: options.sessionFile
      ?? path.join(tempRoot, 'sessions', 'pi-session-1.jsonl'),
    modelProvider: options.modelProvider ?? 'github-copilot',
    modelId: options.modelId ?? 'gpt-5.4',
    modelReasoning: options.modelReasoning ?? true,
    thinkingLevelMap: options.thinkingLevelMap ?? { xhigh: 'xhigh' },
    thinkingLevel: options.thinkingLevel ?? 'off',
    steering: [],
  };
  const behavior = {
    getState: options.getStateBehavior ?? 'accept',
    prompt: options.promptBehavior ?? 'accept',
    setSteeringMode: options.setSteeringModeBehavior ?? 'accept',
    steer: options.steerBehavior ?? 'accept',
    steerResponseDelayMs: options.steerResponseDelayMs ?? 0,
  };
  const signals = [];

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

  const proc = {
    stdout,
    stderr,
    stdin: {
      writes,
      write(chunk) {
        writes.push(chunk);
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          handleCommand(JSON.parse(line));
        }
      },
      async flush() {
        await Promise.resolve();
      },
      end() {},
    },
    killed: false,
    exited: new Promise((resolve) => {
      resolveExited = resolve;
    }),
    close(exitCode = 0) {
      if (closed) return;
      closed = true;
      try {
        stdoutController.close();
        stderrController.close();
      } catch {
        // Already closed.
      }
      resolveExited(exitCode);
    },
    kill(signal = 'SIGTERM') {
      this.killed = true;
      signals.push(signal);
      if (options.killDelayMs) {
        setTimeout(() => this.close(signal === 'SIGKILL' ? 137 : 143), options.killDelayMs);
      } else {
        this.close(signal === 'SIGKILL' ? 137 : 143);
      }
    },
  };

  function closeProc(exitCode = 0) {
    proc.close(exitCode);
  }

  function respond(id, body, delayMs = 0) {
    setTimeout(() => {
      if (closed) return;
      stdoutController.enqueue(encoder.encode(`${JSON.stringify({ id, ...body })}\n`));
    }, delayMs);
  }

  function handleCommand(command) {
    commands.push(command);
    if (typeof command.id !== 'string') return;
    switch (command.type) {
      case 'set_steering_mode':
        if (behavior.setSteeringMode === 'hold') return;
        respond(command.id, { type: 'response', command: 'set_steering_mode', success: true });
        return;
      case 'get_state':
        if (behavior.getState === 'hold') return;
        respond(command.id, {
          type: 'response',
          command: 'get_state',
          success: true,
          data: {
            sessionId: state.sessionId,
            sessionFile: state.sessionFile,
            steeringMode: 'all',
            thinkingLevel: state.thinkingLevel,
            model: {
              provider: state.modelProvider,
              id: state.modelId,
              reasoning: state.modelReasoning,
              thinkingLevelMap: state.thinkingLevelMap,
            },
          },
        });
        return;
      case 'prompt':
        if (behavior.prompt === 'hold') return;
        if (behavior.prompt === 'reject') {
          respond(command.id, {
            type: 'response',
            command: 'prompt',
            success: false,
            error: 'scripted prompt rejection',
          });
          return;
        }
        respond(command.id, { type: 'response', command: 'prompt', success: true });
        return;
      case 'steer':
        if (behavior.steer === 'reject') {
          respond(command.id, {
            type: 'response',
            command: 'steer',
            success: false,
            error: 'Extension command "/x" cannot be queued as steering',
          });
          return;
        }
        state.steering.push(command.message);
        stdoutController.enqueue(encoder.encode(`${JSON.stringify({
          type: 'queue_update',
          steering: [...state.steering],
          followUp: [],
        })}\n`));
        if (behavior.steer === 'exit') {
          setTimeout(() => closeProc(7), 0);
          return;
        }
        if (behavior.steer === 'hold') return;
        respond(
          command.id,
          { type: 'response', command: 'steer', success: true },
          behavior.steerResponseDelayMs,
        );
        return;
      case 'abort':
        respond(command.id, { type: 'response', command: 'abort', success: true });
        return;
      default:
        respond(command.id, { type: 'response', command: command.type, success: true });
    }
  }

  return {
    proc,
    writes,
    commands,
    signals,
    state,
    behavior,
    pushEvent(event) {
      if (closed) return;
      stdoutController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    pushRaw(line) {
      if (closed) return;
      stdoutController.enqueue(encoder.encode(`${line}\n`));
    },
    pushStderr(text) {
      if (closed) return;
      stderrController.enqueue(encoder.encode(text));
    },
    close: closeProc,
  };
}

let fakes;
let spawnMock;

function baseStartRequest(overrides = {}) {
  return {
    command: 'hello',
    chatId: 'chat-1',
    projectPath: path.join(tempRoot, 'project'),
    model: 'github-copilot/gpt-5.4',
    permissionMode: 'default',
    thinkingMode: 'none',
    operation: { runId: 'run-default', publish() {} },
    ...overrides,
  };
}

function baseResumeRequest(overrides = {}) {
  return {
    ...baseStartRequest({ chatId: 'chat-2', command: 'continue' }),
    agentSessionId: 'pi-session-1',
    nativePath: path.join(tempRoot, 'sessions', 'pi-session-1.jsonl'),
    ...overrides,
  };
}

function collect(runtime) {
  const seen = { messages: [], processing: [], finished: [], failed: [], created: [] };
  runtime.onMessages((chatId, messages) => seen.messages.push({ chatId, messages }));
  runtime.onProcessing((chatId, isProcessing) => seen.processing.push({ chatId, isProcessing }));
  runtime.onFinished((chatId) => seen.finished.push(chatId));
  runtime.onFailed((chatId, message) => seen.failed.push({ chatId, message }));
  runtime.onSessionCreated((chatId) => seen.created.push(chatId));
  return seen;
}

function collectOperation(runId: string) {
  const events: AgentRuntimeEvent[] = [];
  return {
    events,
    operation: {
      runId,
      publish(event: AgentRuntimeEvent) {
        events.push(event);
      },
    },
  };
}

async function settleIo() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function waitForActive(runtime, agentSessionId = 'pi-session-1') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const target = runtime.captureSteerTarget(agentSessionId);
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Pi session ${agentSessionId} did not become active`);
}

async function waitForCommand(fake, type) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const command = fake.commands.find((candidate) => candidate.type === type);
    if (command) return command;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Pi command ${type} was not written`);
}

describe('PiRpcRuntime', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-pi-rpc-'));
    await fs.mkdir(path.join(tempRoot, 'project'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'sessions'), { recursive: true });
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tempRoot, 'sessions');
    process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, 'agent');
    fakes = [];
    spawnOptions = [];
    spawnMock = mock(() => {
      const fake = createFakePiProcess(spawnOptions.shift() ?? {});
      fakes.push(fake);
      return fake.proc;
    });
    Bun.spawn = spawnMock;
  });

  afterEach(async () => {
    Bun.spawn = originalSpawn;
    process.env = { ...originalEnv };
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  let spawnOptions = [];

  it('starts a session with RPC args, readiness handshake, and no --session flag', async () => {
    const runtime = createRuntime();
    const seen = collect(runtime);
    const started = await runtime.startSession(baseStartRequest());

    expect(started.agentSessionId).toBe('pi-session-1');
    expect(started.nativePath).toBe(path.join(tempRoot, 'sessions', 'pi-session-1.jsonl'));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc']));
    expect(args).toEqual(expect.arrayContaining(['--model', 'github-copilot/gpt-5.4']));
    expect(args).toEqual(expect.arrayContaining(['--thinking', 'off']));
    expect(args).not.toContain('--session');
    expect(seen.created).toEqual(['chat-1']);

    const fake = fakes[0];
    expect(fake.commands.map((command) => command.type)).toEqual([
      'set_steering_mode',
      'get_state',
      'prompt',
    ]);
    expect(fake.commands[0].mode).toBe('all');
    const prompt = fake.commands.find((command) => command.type === 'prompt');
    expect(prompt.message).toBe('hello');

    fake.pushEvent({ type: 'agent_settled' });
    await settleIo();
    expect(seen.finished).toEqual(['chat-1']);
    await runtime.shutdown();
  });

  it('scrubs nested Pi session environment and preserves extension configuration', async () => {
    process.env.PI_SESSION_FILE = '/home/someone/session.jsonl';
    process.env.PI_SESSION_ID = 'outer-session';
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tempRoot, 'sessions');
    process.env.PI_MODELS_DEV_OVERRIDE_PROVIDERS = 'all';
    process.env.GARCON_EMBEDDED_PI_PACKAGE_DIR = '/tmp/embedded-pi';
    process.env.PI_PACKAGE_DIR = '/tmp/embedded-pi';
    const runtime = createRuntime();
    await runtime.startSession(baseStartRequest());

    const env = spawnMock.mock.calls[0][1].env;
    expect(env.PI_SESSION_FILE).toBeUndefined();
    expect(env.PI_SESSION_ID).toBeUndefined();
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(env.GARCON_EMBEDDED_PI_PACKAGE_DIR).toBeUndefined();
    expect(env.PI_PACKAGE_DIR).toBeUndefined();
    expect(env.PI_OFFLINE).toBe('1');
    expect(env.PI_SKIP_VERSION_CHECK).toBe('1');
    expect(env.PI_TELEMETRY).toBe('0');
    expect(env.PI_MODELS_DEV_OVERRIDE_PROVIDERS).toBe('all');
    await runtime.shutdown();
  });

  it('rejects startSession when the resolved model differs from the requested one', async () => {
    spawnOptions.push({ modelId: 'other-model' });
    const runtime = createRuntime();
    await expect(runtime.startSession(baseStartRequest())).rejects.toThrow(
      /resolved model/,
    );
    await runtime.shutdown();
  });

  it('accepts a requested thinking level that Pi clamps for the resolved model', async () => {
    spawnOptions.push({
      modelProvider: 'fireworks',
      modelId: 'accounts/fireworks/models/kimi-k3',
      thinkingLevel: 'minimal',
      thinkingLevelMap: { off: null, minimal: 'low' },
    });
    const runtime = createRuntime();
    const started = await runtime.startSession(baseStartRequest({
      model: 'fireworks/accounts/fireworks/models/kimi-k3',
      thinkingMode: 'none',
    }));

    expect(started.agentSessionId).toBe('pi-session-1');
    fakes[0].pushEvent({ type: 'agent_settled' });
    await settleIo();
    await runtime.shutdown();
  });

  it('rejects startSession when the process exits before readiness', async () => {
    spawnMock.mockImplementation(() => {
      const fake = createFakePiProcess();
      fakes.push(fake);
      setTimeout(() => fake.close(1), 1);
      return fake.proc;
    });
    const runtime = createRuntime();
    await expect(runtime.startSession(baseStartRequest())).rejects.toBeDefined();
    await runtime.shutdown();
  });

  it('returns initial session identity before prompt preflight completes', async () => {
    spawnOptions.push({ promptBehavior: 'hold' });
    const runtime = createRuntime();
    const seen = collect(runtime);

    const started = await runtime.startSession(baseStartRequest());

    expect(started.agentSessionId).toBe('pi-session-1');
    expect(runtime.isRunning(started.agentSessionId)).toBe(true);
    expect(runtime.captureSteerTarget(started.agentSessionId)).toBeNull();
    expect(runtime.abort(started.agentSessionId)).toBe(true);
    await settleIo();
    expect(fakes[0].proc.killed).toBe(true);
    expect(seen.failed).toEqual([]);
    // The stop is turn-terminal work: one finished event releases the turn.
    expect(seen.finished).toEqual(['chat-1']);
    await runtime.shutdown();
  });

  it('reports an initial prompt rejection after session identity is returned', async () => {
    spawnOptions.push({ promptBehavior: 'reject' });
    const runtime = createRuntime();
    const seen = collect(runtime);

    const started = await runtime.startSession(baseStartRequest());
    expect(started.agentSessionId).toBe('pi-session-1');
    await settleIo();

    expect(seen.failed).toHaveLength(1);
    expect(seen.failed[0].message).toContain('scripted prompt rejection');
    expect(fakes[0].proc.killed).toBe(true);
    await runtime.shutdown();
  });

  it('kills a process whose readiness handshake is still pending during shutdown', async () => {
    spawnOptions.push({ setSteeringModeBehavior: 'hold' });
    const runtime = createRuntime();
    const starting = runtime.startSession(baseStartRequest());
    while (fakes.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await waitForCommand(fakes[0], 'set_steering_mode');

    await runtime.shutdown();

    await expect(starting).rejects.toBeDefined();
    expect(fakes[0].proc.killed).toBe(true);
    expect(runtime.getRunningSessions()).toEqual([]);
  });

  it('reuses a warm session for matching turns and respawns on model drift', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();

    const firstTurn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    const firstStartedAt = runtime.getRunningSessions()[0].startedAt;
    fakes[0].pushEvent({ type: 'agent_settled' });
    await firstTurn;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondTurn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    const secondStartedAt = runtime.getRunningSessions()[0].startedAt;
    expect(new Date(secondStartedAt).getTime()).toBeGreaterThan(new Date(firstStartedAt).getTime());
    fakes[0].pushEvent({ type: 'agent_settled' });
    await secondTurn;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Steering mode is part of every readiness handshake, including the single spawn.
    expect(fakes[0].commands.filter((command) => command.type === 'set_steering_mode'))
      .toHaveLength(1);

    const movedProject = path.join(tempRoot, 'moved-project');
    const movedTurn = runtime.runTurn(baseResumeRequest({ projectPath: movedProject }));
    await waitForActive(runtime);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await movedTurn;
    expect(spawnMock).toHaveBeenCalledTimes(1);

    spawnOptions.push({ modelId: 'gpt-9' });
    const driftTurn = runtime.runTurn(baseResumeRequest({ model: 'github-copilot/gpt-9' }));
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(fakes[1].commands.filter((command) => command.type === 'set_steering_mode'))
      .toHaveLength(1);
    fakes[1].pushEvent({ type: 'agent_settled' });
    await driftTurn;
    await runtime.shutdown();
  });

  it('serializes turn launch and never starts two processes for one session concurrently', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();

    const first = runtime.runTurn(baseResumeRequest());
    await expect(runtime.runTurn(baseResumeRequest())).rejects.toThrow(/already starting a turn/);
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await first;
    await runtime.shutdown();
  });

  it('awaits old-process exit and fences its buffered events before a drift respawn', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ killDelayMs: 30 });
    const runtime = createRuntime();
    const seen = collect(runtime);
    const first = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await first;
    expect(seen.finished).toHaveLength(1);

    spawnOptions.push({ modelId: 'gpt-9' });
    const drift = runtime.runTurn(baseResumeRequest({ model: 'github-copilot/gpt-9' }));
    await settleIo();
    expect(fakes[0].signals).toEqual(['SIGTERM']);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Output buffered after retirement belongs to the old generation and is ignored.
    fakes[0].pushEvent({ type: 'agent_settled' });
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(seen.finished).toHaveLength(1);
    fakes[1].pushEvent({ type: 'agent_settled' });
    await drift;
    await runtime.shutdown();
  });

  it('keeps active sessions through purge ticks and awaits an idle-purge tombstone', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ killDelayMs: 30 });
    const runtime = createRuntime({ idlePurgeTiming: { intervalMs: 1, maxIdleMs: 0 } });
    const first = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    runtime.startPurgeTimer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fakes[0].proc.killed).toBe(false);

    fakes[0].pushEvent({ type: 'agent_settled' });
    await first;
    while (!fakes[0].proc.killed) await new Promise((resolve) => setTimeout(resolve, 1));

    const next = runtime.runTurn(baseResumeRequest());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    fakes[1].pushEvent({ type: 'agent_settled' });
    await next;
    await runtime.shutdown();
  });

  it('verifies thinking identity and respawns when thinking changes', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ thinkingLevel: 'medium' });
    const runtime = createRuntime();
    await expect(runtime.runTurn(baseResumeRequest({ thinkingMode: 'high' }))).rejects.toThrow(
      /thinking level/,
    );

    spawnOptions.push({ thinkingLevel: 'high' });
    const turn = runtime.runTurn(baseResumeRequest({ thinkingMode: 'high' }));
    await waitForActive(runtime);
    expect(spawnMock.mock.calls[1][0]).toEqual(expect.arrayContaining(['--thinking', 'high']));
    fakes[1].pushEvent({ type: 'agent_settled' });
    await turn;

    spawnOptions.push({ thinkingLevel: 'xhigh' });
    const ultraTurn = runtime.runTurn(baseResumeRequest({ thinkingMode: 'ultra' }));
    await waitForActive(runtime);
    expect(spawnMock.mock.calls[2][0]).toEqual(expect.arrayContaining(['--thinking', 'xhigh']));
    fakes[2].pushEvent({ type: 'agent_settled' });
    await ultraTurn;
    await runtime.shutdown();
  });

  it('resumes only with an existing absolute session path, never a bare id', async () => {
    const runtime = createRuntime();
    const missing = baseResumeRequest({
      nativePath: path.join(tempRoot, 'sessions', 'missing.jsonl'),
      agentSessionId: 'missing-session',
    });
    await expect(runtime.runTurn(missing)).rejects.toThrow(/could not be resolved/);
    expect(spawnMock).not.toHaveBeenCalled();

    await fs.writeFile(baseResumeRequest().nativePath, '');
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    const args = spawnMock.mock.calls[0][0];
    const sessionFlagIndex = args.indexOf('--session');
    expect(sessionFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[sessionFlagIndex + 1]).toBe(baseResumeRequest().nativePath);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    await runtime.shutdown();
  });

  it('canonicalizes resume paths and rejects non-files before spawning', async () => {
    const realPath = baseResumeRequest().nativePath;
    const symlinkPath = path.join(tempRoot, 'sessions', 'linked-session.jsonl');
    await fs.writeFile(realPath, '');
    await fs.symlink(realPath, symlinkPath);
    const runtime = createRuntime();

    const turn = runtime.runTurn(baseResumeRequest({ nativePath: symlinkPath }));
    await waitForActive(runtime);
    const args = spawnMock.mock.calls[0][0];
    expect(args[args.indexOf('--session') + 1]).toBe(realPath);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    await runtime.shutdown();

    await fs.rm(realPath);
    await fs.mkdir(realPath);
    const invalidRuntime = createRuntime();
    await expect(invalidRuntime.runTurn(baseResumeRequest())).rejects.toThrow(
      /could not be resolved/,
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await invalidRuntime.shutdown();
  });

  it('maps valid image data URLs to RPC prompt images and rejects malformed attachments', async () => {
    const runtime = createRuntime();
    await runtime.startSession(baseStartRequest({
      images: [{
        name: 'screen.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,aW1hZ2U=',
      }],
    }));
    const prompt = fakes[0].commands.find((command) => command.type === 'prompt');
    expect(prompt.images).toEqual([{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await settleIo();
    await runtime.shutdown();

    const malformedRuntime = createRuntime();
    await expect(malformedRuntime.startSession(baseStartRequest({
      images: [{ name: 'notes.txt', mimeType: 'text/plain', data: 'not-a-data-url' }],
    }))).rejects.toThrow(/only base64 image data URLs/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await malformedRuntime.shutdown();
  });

  it('fails the turn when the resumed identity does not match the registry', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ sessionId: 'some-other-session' });
    const runtime = createRuntime();
    await expect(runtime.runTurn(baseResumeRequest())).rejects.toThrow(
      /resumed session/,
    );
    await runtime.shutdown();
  });

  it('routes tool and assistant events and settles only on agent_settled', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const seen = collect(runtime);
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const fake = fakes[0];
    // Finalized message occurrences carry the rendered rows, tools included;
    // per-run tool execution events are progress-only.
    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'echo hi' } }],
        stopReason: 'toolUse',
        timestamp: 0,
      },
    });
    fake.pushEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
    });
    fake.pushEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      result: { content: [{ type: 'text', text: 'hi' }] },
      isError: false,
    });
    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'hi' }],
        timestamp: 0,
      },
    });
    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        timestamp: 0,
      },
    });
    await settleIo();
    expect(seen.finished).toEqual([]);

    // agent_end is a per-run event, not a terminal one.
    fake.pushEvent({ type: 'agent_end', messages: [] });
    await settleIo();
    expect(seen.finished).toEqual([]);

    fake.pushEvent({ type: 'agent_settled' });
    await turn;
    expect(seen.finished).toEqual(['chat-2']);
    expect(seen.messages.flatMap((entry) => entry.messages)).toHaveLength(3);
    await runtime.shutdown();
  });

  it('[TLV5-L07.03-PI-UNIT-01] publishes sequential turns through the concrete operation that started each turn', async () => {
    const runtime = createRuntime();
    const first = collectOperation('run-a');
    const started = await runtime.startSession(baseStartRequest({ operation: first.operation }));
    const fake = fakes[0];
    await fs.writeFile(started.nativePath, '');

    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'from operation A' }],
        stopReason: 'stop',
        timestamp: 0,
      },
    });
    fake.pushEvent({ type: 'agent_settled' });
    await settleIo();

    const second = collectOperation('run-b');
    const secondTurn = runtime.runTurn(baseResumeRequest({
      agentSessionId: started.agentSessionId,
      chatId: 'chat-1',
      operation: second.operation,
    }));
    await waitForActive(runtime);
    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'from operation B' }],
        stopReason: 'stop',
        timestamp: 0,
      },
    });
    fake.pushEvent({ type: 'agent_settled' });
    await secondTurn;

    expect(first.events.map((event) => [event.type, 'runId' in event ? event.runId : null]))
      .toEqual([['messages', 'run-a'], ['run-ended', 'run-a']]);
    expect(second.events.map((event) => [event.type, 'runId' in event ? event.runId : null]))
      .toEqual([['messages', 'run-b'], ['run-ended', 'run-b']]);
    expect(JSON.stringify(first.events)).toContain('from operation A');
    expect(JSON.stringify(first.events)).not.toContain('from operation B');
    expect(JSON.stringify(second.events)).toContain('from operation B');
    expect(JSON.stringify(second.events)).not.toContain('from operation A');
    await runtime.shutdown();
  });

  it('[TLV5-L07.04-PI-UNIT-01] keeps an active turn route when another chat collides on the same native session', async () => {
    const runtime = createRuntime();
    const first = collectOperation('run-a');
    const started = await runtime.startSession(baseStartRequest({
      chatId: 'chat-a',
      operation: first.operation,
    }));
    const colliding = collectOperation('run-b');

    await expect(runtime.runTurn(baseResumeRequest({
      agentSessionId: started.agentSessionId,
      chatId: 'chat-b',
      operation: colliding.operation,
    }))).rejects.toThrow(/already running/);

    fakes[0].pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'still belongs to A' }],
        stopReason: 'stop',
        timestamp: 0,
      },
    });
    fakes[0].pushEvent({ type: 'agent_settled' });
    await settleIo();

    expect(JSON.stringify(first.events)).toContain('still belongs to A');
    expect(first.events.at(-1)).toMatchObject({ type: 'run-ended', runId: 'run-a' });
    expect(colliding.events).toEqual([]);
    await runtime.shutdown();
  });

  it('[TLV5-L07.05-PI-UNIT-01] logs and drops a message emitted without an active turn', async () => {
    const warnings: Array<{ message: string; context: unknown }> = [];
    const runtime = createRuntime({
      logger: {
        ...testLogger,
        warn(message, context) {
          warnings.push({ message, context });
        },
      },
    });
    const operation = collectOperation('run-a');
    await runtime.startSession(baseStartRequest({ operation: operation.operation }));
    fakes[0].pushEvent({ type: 'agent_settled' });
    await settleIo();
    fakes[0].pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'unnamed late output' }],
        stopReason: 'stop',
        timestamp: 0,
      },
    });
    await settleIo();

    expect(operation.events).toHaveLength(1);
    expect(operation.events[0]).toMatchObject({ type: 'run-ended', runId: 'run-a' });
    expect(warnings).toContainEqual(expect.objectContaining({
      message: 'Ignoring Pi message without an active turn',
    }));
    await runtime.shutdown();
  });

  it('keeps malformed output and stderr content out of diagnostics', async () => {
    const privateContent = 'private-pi-transcript-content';
    const diagnostics: unknown[][] = [];
    const runtime = createRuntime({
      logger: {
        debug(...args) { diagnostics.push(args); },
        info(...args) { diagnostics.push(args); },
        warn(...args) { diagnostics.push(args); },
        error(...args) { diagnostics.push(args); },
      },
    });

    await runtime.startSession(baseStartRequest());
    fakes[0].pushRaw(`{${privateContent}`);
    fakes[0].pushStderr(`${privateContent}\n`);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await settleIo();
    await runtime.shutdown();

    expect(JSON.stringify(diagnostics)).not.toContain(privateContent);
  });

  it('[TLV5-L07.08-PI-UNIT-01] contains a closed publisher and keeps the native session reusable', async () => {
    const warnings: Array<{ message: string; context: Record<string, unknown> }> = [];
    const runtime = createRuntime({
      logger: {
        ...testLogger,
        warn(message, context) {
          warnings.push({ message, context });
        },
      },
    });
    const started = await runtime.startSession(baseStartRequest({
      operation: {
        runId: 'run-stale',
        publish() {
          throw new Error('Transcript producer sink is closed');
        },
      },
    }));
    const fake = fakes[0];

    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'rejected stale output' }],
        stopReason: 'stop',
        timestamp: 0,
      },
    });
    fake.pushEvent({ type: 'agent_settled' });
    await settleIo();

    expect(warnings.map(({ message, context }) => [message, context.eventType, context.error]))
      .toEqual([
        ['Pi publisher rejected an event', 'messages', 'Transcript producer sink is closed'],
        ['Pi publisher rejected an event', 'run-ended', 'Transcript producer sink is closed'],
      ]);

    await fs.writeFile(started.nativePath, '');
    const current = collectOperation('run-current');
    const currentTurn = runtime.runTurn(baseResumeRequest({
      agentSessionId: started.agentSessionId,
      chatId: 'chat-1',
      nativePath: started.nativePath,
      operation: current.operation,
    }));
    await waitForActive(runtime, started.agentSessionId);
    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'accepted current output' }],
        stopReason: 'stop',
        timestamp: 0,
      },
    });
    fake.pushEvent({ type: 'agent_settled' });
    await currentTurn;

    expect(current.events.map((event) => event.type)).toEqual(['messages', 'run-ended']);
    expect(current.events[0]).toMatchObject({
      type: 'messages',
      runId: 'run-current',
      rows: [{ message: { type: 'assistant-message', content: 'accepted current output' } }],
    });
    await runtime.shutdown();
  });

  it('settles a tool-only turn without waiting for native persistence', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const fake = fakes[0];
    // The finalized assistant carries only a tool call and renders no text,
    // and the tool result finalizes as its own native message.
    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'true' } }],
        stopReason: 'toolUse',
        timestamp: 0,
      },
    });
    fake.pushEvent({
      type: 'message_end',
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: '' }],
        toolCallId: 'call-1',
        timestamp: 0,
      },
    });
    fake.pushEvent({ type: 'agent_settled' });
    await turn;

    await expect(fs.readFile(baseResumeRequest().nativePath, 'utf8')).resolves.toBe('');
    await runtime.shutdown();
  });

  it('settles the turn even when a lifecycle listener throws', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const seen = collect(runtime);
    runtime.onProcessing(() => {
      throw new Error('processing listener failed');
    });
    runtime.onFinished(() => {
      throw new Error('finished listener failed');
    });

    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;

    expect(seen.finished).toEqual(['chat-2']);
    expect(runtime.isRunning('pi-session-1')).toBe(false);
    await runtime.shutdown();
  });

  it('fails the turn and retires the session when Pi rejects the prompt', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ promptBehavior: 'reject' });
    const runtime = createRuntime();
    const seen = collect(runtime);
    await expect(runtime.runTurn(baseResumeRequest())).rejects.toThrow(
      /scripted prompt rejection/,
    );
    expect(seen.failed).toHaveLength(1);
    await settleIo();

    // The retired process is replaced by a fresh spawn on the next turn.
    spawnOptions.push({});
    const recovery = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    fakes[1].pushEvent({ type: 'agent_settled' });
    await recovery;
    await runtime.shutdown();
  });

  it('fails the turn when the process exits unexpectedly mid-run', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const seen = collect(runtime);
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    fakes[0].close(7);
    await turn;
    expect(seen.failed.map((entry) => entry.message)).toEqual([
      'Pi process exited before completion (code 7)',
    ]);
    expect(seen.finished).toEqual([]);
    await runtime.shutdown();
  });

  it('stop kills the process, emits one stop terminal, and resolves the turn', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const seen = collect(runtime);
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    expect(runtime.isRunning('pi-session-1')).toBe(true);
    expect(runtime.abort('pi-session-1')).toBe(true);
    await turn;
    expect(seen.finished).toEqual(['chat-2']);
    expect(seen.failed).toEqual([]);
    expect(seen.processing.at(-1)).toEqual({ chatId: 'chat-2', isProcessing: false });
    expect(fakes[0].proc.killed).toBe(true);
    expect(runtime.isRunning('pi-session-1')).toBe(false);

    // The next turn respawns on the same session file.
    const recovery = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    fakes[1].pushEvent({ type: 'agent_settled' });
    await recovery;
    await runtime.shutdown();
  });

  it('stops a resumed turn while prompt preflight is still pending', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ promptBehavior: 'hold' });
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    while (fakes.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await waitForCommand(fakes[0], 'prompt');

    expect(runtime.isRunning('pi-session-1')).toBe(true);
    expect(runtime.captureSteerTarget('pi-session-1')).toBeNull();
    expect(runtime.abort('pi-session-1')).toBe(true);
    await turn;
    expect(fakes[0].proc.killed).toBe(true);
    await runtime.shutdown();
  });

  it('logs unsupported extension UI requests without wedging event routing', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const warn = mock(() => {});
    const runtime = new PiRpcRuntime({
      config: testPiConfig,
      logger: { ...testLogger, warn },
      models: testModels,
    });
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    fakes[0].pushEvent({ type: 'extension_ui_request', method: 'confirm' });
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    expect(warn).toHaveBeenCalledWith(
      'Pi extension requested unsupported RPC UI',
      expect.objectContaining({ method: 'confirm' }),
    );
    await runtime.shutdown();
  });

  it('captures steer targets only for live active turns', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    expect(runtime.captureSteerTarget('pi-session-1')).toBeNull();

    const turn = runtime.runTurn(baseResumeRequest());
    const target = await waitForActive(runtime);
    expect(target).not.toBeNull();

    // A second capture returns a distinct opaque token.
    expect(runtime.captureSteerTarget('pi-session-1')).not.toBe(target);

    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    expect(runtime.captureSteerTarget('pi-session-1')).toBeNull();
    expect(runtime.abort('pi-session-1')).toBe(false);
    await runtime.shutdown();
  });

  it('rejects steering without a target, with a stale target, and for / input', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const prepareDelivery = mock(() => Promise.resolve());
    const noTarget = await runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: null,
      input: 'do this instead',
      clientMessageId: 'm-1',
      prepareDelivery,
    });
    expect(noTarget).toEqual({
      kind: 'rejected',
      reason: 'no-active-turn',
      message: 'No active Pi turn',
    });

    const slash = await runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: runtime.captureSteerTarget('pi-session-1'),
      input: '/skill:brave-search do this',
      clientMessageId: 'm-2',
      prepareDelivery,
    });
    expect(slash.kind).toBe('rejected');
    expect(slash.reason).toBe('invalid-input');
    expect(prepareDelivery).not.toHaveBeenCalled();

    // A captured target goes stale once the turn settles.
    const staleTarget = runtime.captureSteerTarget('pi-session-1');
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    const stale = await runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: staleTarget,
      input: 'too late',
      clientMessageId: 'm-3',
      prepareDelivery,
    });
    expect(stale.kind).toBe('rejected');
    expect(stale.reason).toBe('turn-changed');
    await runtime.shutdown();
  });

  it('accepts steering on a live turn and tracks delivery through queue updates', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    // The prompt echo surfaces as a user message; with nothing accepted it must not
    // disturb the delivery ledger.
    fakes[0].state.steering = [];
    fakes[0].pushEvent({ type: 'queue_update', steering: [], followUp: [] });
    fakes[0].pushEvent({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'continue' }], timestamp: 0 },
    });
    await settleIo();

    const target = runtime.captureSteerTarget('pi-session-1');
    const prepareDelivery = mock(() => Promise.resolve());
    const result = await runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target,
      input: 'do this instead',
      clientMessageId: 'm-1',
      prepareDelivery,
    });
    expect(result).toEqual({ kind: 'accepted' });
    expect(prepareDelivery).toHaveBeenCalledTimes(1);
    expect(fakes[0].commands.some((command) =>
      command.type === 'steer' && command.message === 'do this instead')).toBe(true);

    // Delivery evidence then settle: the session stays warm and reusable.
    fakes[0].state.steering = [];
    fakes[0].pushEvent({ type: 'queue_update', steering: [], followUp: [] });
    fakes[0].pushEvent({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'do this instead' }], timestamp: 0 },
    });
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    const nextTurn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    fakes[0].pushEvent({ type: 'agent_settled' });
    await nextTurn;
    await runtime.shutdown();
  });

  it('accepts steering delivered before its response even when the turn settles first', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ steerResponseDelayMs: 30 });
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const steer = runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: runtime.captureSteerTarget('pi-session-1'),
      input: 'delivered before response',
      clientMessageId: 'm-early-delivery',
      prepareDelivery: () => Promise.resolve(),
    });
    await waitForCommand(fakes[0], 'steer');
    fakes[0].state.steering = [];
    fakes[0].pushEvent({ type: 'queue_update', steering: [], followUp: [] });
    fakes[0].pushEvent({
      type: 'message_end',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'delivered before response' }],
        timestamp: 0,
      },
    });
    fakes[0].pushEvent({ type: 'agent_settled' });

    await expect(steer).resolves.toEqual({ kind: 'accepted' });
    await turn;
    expect(fakes[0].proc.killed).toBe(false);
    await runtime.shutdown();
  });

  it('tracks duplicate steering text by occurrence through delivery and persistence', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const steer = (clientMessageId) => runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: runtime.captureSteerTarget('pi-session-1'),
      input: 'same text',
      clientMessageId,
      prepareDelivery: () => Promise.resolve(),
    });
    await expect(steer('m-same-1')).resolves.toEqual({ kind: 'accepted' });
    await expect(steer('m-same-2')).resolves.toEqual({ kind: 'accepted' });

    fakes[0].state.steering = ['same text'];
    fakes[0].pushEvent({ type: 'queue_update', steering: ['same text'], followUp: [] });
    fakes[0].pushEvent({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'same text' }], timestamp: 0 },
    });
    fakes[0].state.steering = [];
    fakes[0].pushEvent({ type: 'queue_update', steering: [], followUp: [] });
    fakes[0].pushEvent({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'same text' }], timestamp: 0 },
    });
    fakes[0].pushEvent({ type: 'agent_settled' });

    await turn;
    expect(fakes[0].proc.killed).toBe(false);
    await runtime.shutdown();
  });

  it('fails steering as unknown and retires when the process exits after the write', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ steerBehavior: 'exit' });
    const runtime = createRuntime();
    const seen = collect(runtime);
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const result = await runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: runtime.captureSteerTarget('pi-session-1'),
      input: 'uncertain steer',
      clientMessageId: 'm-unknown',
      prepareDelivery: () => Promise.resolve(),
    });

    expect(result).toMatchObject({ kind: 'failed', outcome: 'unknown' });
    await turn;
    expect(seen.failed).toHaveLength(1);
    expect(runtime.captureSteerTarget('pi-session-1')).toBeNull();

    spawnOptions.push({});
    const recovery = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    fakes[1].pushEvent({ type: 'agent_settled' });
    await recovery;
    await runtime.shutdown();
  });

  it('retires the process when dequeued steering lacks persistence evidence at settle', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const result = await runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: runtime.captureSteerTarget('pi-session-1'),
      input: 'late steer',
      clientMessageId: 'm-1',
      prepareDelivery: () => Promise.resolve(),
    });
    expect(result).toEqual({ kind: 'accepted' });

    // Queue removal happens before Pi emits and persists the matching user message.
    fakes[0].state.steering = [];
    fakes[0].pushEvent({ type: 'queue_update', steering: [], followUp: [] });
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    await settleIo();
    expect(fakes[0].proc.killed).toBe(true);

    const nextTurn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    fakes[1].pushEvent({ type: 'agent_settled' });
    await nextTurn;
    await runtime.shutdown();
  });

  it('retires the process when Pi settles with steering still queued', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    await expect(runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: runtime.captureSteerTarget('pi-session-1'),
      input: 'late queued steer',
      clientMessageId: 'm-queued',
      prepareDelivery: () => Promise.resolve(),
    })).resolves.toEqual({ kind: 'accepted' });

    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    await settleIo();
    expect(fakes[0].proc.killed).toBe(true);
    await runtime.shutdown();
  });

  it('rejects a steer that missed the run and retires the process', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const target = runtime.captureSteerTarget('pi-session-1');
    // Settle lands while the steer is in flight: the settle event is processed before the
    // steer response resolves, so the post-response state check catches it.
    const steerPromise = runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target,
      input: 'racing steer',
      clientMessageId: 'm-1',
      prepareDelivery: () => Promise.resolve(),
    });
    fakes[0].pushEvent({ type: 'agent_settled' });
    const result = await steerPromise;
    expect(result.kind).toBe('rejected');
    expect(result.reason).toBe('turn-changed');
    await turn;
    await settleIo();
    expect(fakes[0].proc.killed).toBe(true);
    await runtime.shutdown();
  });

  it('defers settlement while a steer delivery is reserved', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const seen = collect(runtime);
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    let releasePrepare;
    const prepareDelivery = () => new Promise((resolve) => {
      releasePrepare = resolve;
    });
    const steerPromise = runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: runtime.captureSteerTarget('pi-session-1'),
      input: 'held steer',
      clientMessageId: 'm-1',
      prepareDelivery,
    });
    await settleIo();

    // Settle arrives mid-delivery: finish is stashed until the reservation releases.
    fakes[0].pushEvent({ type: 'agent_settled' });
    await settleIo();
    expect(seen.finished).toEqual([]);
    expect(runtime.captureSteerTarget('pi-session-1')).toBeNull();

    releasePrepare();
    await expect(steerPromise).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'turn-changed',
    });
    await turn;
    expect(seen.finished).toEqual(['chat-2']);
    expect(fakes[0].proc.killed).toBe(false);
    await runtime.shutdown();
  });

  it('classifies provider steer rejections instead of reporting unknown', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    spawnOptions.push({ steerBehavior: 'reject' });
    const runtime = createRuntime();
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    const result = await runtime.steer({
      chatId: 'chat-2',
      projectPath: baseResumeRequest().projectPath,
      agentSessionId: 'pi-session-1',
      nativeSession: null,
      target: runtime.captureSteerTarget('pi-session-1'),
      input: 'rejected steer',
      clientMessageId: 'm-1',
      prepareDelivery: () => Promise.resolve(),
    });
    expect(result.kind).toBe('rejected');
    expect(result.reason).toBe('invalid-input');
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    await runtime.shutdown();
  });

  it('drains fragmented stderr lines through the logger', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const info = mock(() => {});
    const runtime = new PiRpcRuntime({
      config: testPiConfig,
      logger: { ...testLogger, info },
      models: testModels,
    });
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);

    fakes[0].pushStderr('first line\npartial');
    fakes[0].pushStderr(' line\n');
    fakes[0].pushEvent({ type: 'agent_settled' });
    await turn;
    await settleIo();

    expect(info.mock.calls.map((call) => call[1])).toEqual([
      { sessionId: 'pi-session-1', lineLength: 10 },
      { sessionId: 'pi-session-1', lineLength: 12 },
    ]);
    await runtime.shutdown();
  });

  it('shuts down by settling active turns and killing every process', async () => {
    await fs.writeFile(baseResumeRequest().nativePath, '');
    const runtime = createRuntime();
    const seen = collect(runtime);
    const turn = runtime.runTurn(baseResumeRequest());
    await waitForActive(runtime);
    await runtime.shutdown();
    await turn;
    expect(fakes[0].proc.killed).toBe(true);
    expect(seen.processing.at(-1)).toEqual({ chatId: 'chat-2', isProcessing: false });
    expect(runtime.getRunningSessions()).toEqual([]);
    expect(runtime.captureSteerTarget('pi-session-1')).toBeNull();
  });
});
