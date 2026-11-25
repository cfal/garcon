import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { AcpInitializeResult, AcpJsonRpcMessage } from '@garcon/server-agent-common/acp/protocol';
import { AcpAgentRuntime } from '@garcon/server-agent-common/acp/agent-runtime';
import { AcpExecution } from '@garcon/server-agent-common/acp/execution';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import type { AcpStartRequest } from '@garcon/server-agent-common/acp/runtime-types';
import { AcpTransport, type AcpProcess } from '@garcon/server-agent-common/acp/transport';
import {
  runtimeOperation,
  type AgentRuntimeEvent,
  type RuntimeSteerRequest,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { AntigravityConfig } from '../../../config.ts';
import { AntigravityAcpEventConverter } from '../antigravity-acp-event-converter.ts';
import { applyAntigravityMode, createAntigravityAcpPolicy } from '../antigravity-acp-policy.ts';
import { runAntigravitySingleQuery } from '../run-single-query.ts';

const MODELS = {
  currentModelId: 'gemini-test-low',
  availableModels: [
    { modelId: 'gemini-test-low', name: 'Gemini Test (Low)' },
    { modelId: 'gemini-test-high', name: 'Gemini Test (High)' },
  ],
};

const MODE_OPTION = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default' }, { value: 'accept-edits' }, { value: 'plan' }],
};

const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

// Speaks the agy 1.5 ACP shapes the runtime depends on: agent-defined
// permission option ids, `session/cancel` as a notification, upstream
// failures reported as a message chunk followed by `end_turn`, and a prompt
// sent during a turn settling the open prompt and joining that turn.
class FakeAntigravityAgent {
  readonly received: AcpJsonRpcMessage[] = [];
  readonly sessions = new Set<string>();
  #nextSession = 1;
  readonly #sessionModels = new Map<string, string>();
  // When set, sessions offer only these models, as another account would.
  resumeAvailableModels: unknown = MODELS.availableModels;
  #stdout!: ReadableStreamDefaultController<Uint8Array>;
  #stderr!: ReadableStreamDefaultController<Uint8Array>;
  #openPrompt: { id: number | string; sessionId: string } | null = null;
  readonly #unansweredPermissions = new Set<string>();
  // When set, a prompt sent during a turn is refused, as agy refuses one while a permission is unanswered.
  refusesOverlappingPrompts = false;
  #script: (agent: FakeAntigravityAgent, sessionId: string) => void = () => {};
  // Delays or drops the reply to `session/cancel`, as a slow or unresponsive agent would.
  cancelReply: 'immediate' | 'deferred' | 'ignored' = 'immediate';
  resumeConfigOptions: (typeof MODE_OPTION)[] | undefined = [MODE_OPTION];
  modeOptions: Array<{ value: string }> = MODE_OPTION.options;
  configReply?: Record<string, unknown>;
  // When set, `session/resume` fails with this internal error.
  resumeFailure: string | null = null;
  // When set, `session/resume` replies only after this settles.
  resumeGate: Promise<void> | null = null;
  newSessionGate: Promise<void> | null = null;
  newSessionFailure: string | null = null;
  processesKilled = 0;
  capabilities: AcpInitializeResult['agentCapabilities'] = { loadSession: true, sessionCapabilities: { resume: {} } };
  authMethods: AcpInitializeResult['authMethods'] = [{ id: 'oauth-personal' }];
  resumeErrorCode = -32603;
  // When set, `session/set_config_option` replies only after this settles.
  configReplyGate: Promise<void> | null = null;
  promptFlush: Promise<number> | null = null;
  exitAfterKill: Promise<void> | null = null;

  // Each spawn is a fresh process; later frames go to the newest one.
  // Ends the newest process as a crash would.
  crash(code = 1): void {
    this.#exitCurrent?.(code);
  }

  breakStdout(): void {
    this.#stdout.error(new Error('Synthetic stdout failure'));
  }

  closeStdout(): void {
    this.#stdout.close();
  }

  endPromptAtEof(): void {
    const reply = { id: this.#takeOpenPrompt().id, result: { stopReason: 'end_turn' } };
    this.#stdout.enqueue(new TextEncoder().encode(JSON.stringify(reply)));
    this.closeStdout();
  }

  #exitCurrent: ((code: number) => void) | null = null;

  process(): AcpProcess {
    const exited = Promise.withResolvers<number>();
    this.#exitCurrent = exited.resolve;
    this.#openPrompt = null;
    return {
      stdin: { write: (data: string | Uint8Array) => this.#receive(String(data)), flush: () => this.promptFlush ?? 0 },
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => { this.#stdout = controller; } }),
      stderr: new ReadableStream<Uint8Array>({ start: controller => { this.#stderr = controller; } }),
      exited: exited.promise,
      kill: () => {
        this.processesKilled++;
        if (this.exitAfterKill) void this.exitAfterKill.then(() => exited.resolve(143));
        else exited.resolve(143);
      },
    };
  }

  onPrompt(script: (agent: FakeAntigravityAgent, sessionId: string) => void): void {
    this.#script = script;
  }

  requests(method: string): AcpJsonRpcMessage[] {
    return this.received.filter((message) => message.method === method);
  }

  update(sessionId: string, update: Record<string, unknown>): void {
    this.#send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }

  requestPermission(sessionId: string, toolCallId: string, options = PERMISSION_OPTIONS, id = 'permission-1'): void {
    this.requestToolPermission(sessionId, { toolCallId, name: 'run_command', kind: 'execute', status: 'pending',
      rawInput: { CommandLine: 'echo synthetic' } }, options, id);
  }

  stderr(line: string): void {
    this.#stderr.enqueue(new TextEncoder().encode(line + '\n'));
  }

  requestToolPermission(sessionId: string, toolCall: Record<string, unknown>, options = PERMISSION_OPTIONS, id = 'permission-1'): void {
    this.#unansweredPermissions.add(id);
    this.#send({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall,
        options,
      },
    });
  }

  #takeOpenPrompt() {
    const prompt = this.#openPrompt;
    if (!prompt) throw new Error('No open prompt');
    this.#openPrompt = null;
    return prompt;
  }

  failPrompt(message: string): void {
    this.#send({ jsonrpc: '2.0', id: this.#takeOpenPrompt().id, error: { code: -32603, message } });
  }

  endPrompt(stopReason = 'end_turn'): void {
    this.#send({ jsonrpc: '2.0', id: this.#takeOpenPrompt().id, result: { stopReason } });
  }

  #receive(data: string): number {
    for (const line of data.split('\n')) {
      if (line.trim()) this.#handle(JSON.parse(line) as AcpJsonRpcMessage);
    }
    return Buffer.byteLength(data);
  }

  #handle(message: AcpJsonRpcMessage): void {
    this.received.push(message);
    if (message.method === undefined) this.#unansweredPermissions.delete(String(message.id));
    const params = (message.params ?? {}) as Record<string, unknown>;
    const reply = (result: unknown, gate?: Promise<void> | null) => {
      const send = () => this.#send({ jsonrpc: '2.0', id: message.id, result });
      if (gate) void gate.then(send);
      else send();
    };
    switch (message.method) {
      case 'initialize':
        return reply({ protocolVersion: 1, agentCapabilities: this.capabilities, authMethods: this.authMethods });
      case 'authenticate':
        return reply({});
      case 'session/set_model':
        // agy keeps the chosen model with the conversation, so a resume reports it.
        this.#sessionModels.set(String(params.sessionId), String(params.modelId));
        return reply({});
      case 'session/new': {
        if (this.newSessionFailure) {
          return this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: this.newSessionFailure } });
        }
        const sessionId = `session-${this.#nextSession++}`;
        this.sessions.add(sessionId);
        const result = { sessionId, models: MODELS, configOptions: [{ ...MODE_OPTION, options: this.modeOptions }] };
        return reply(result, this.newSessionGate);
      }
      case 'session/resume': {
        if (this.resumeFailure) {
          return this.#send({ jsonrpc: '2.0', id: message.id, error: { code: this.resumeErrorCode, message: this.resumeFailure } });
        }
        if (!this.sessions.has(String(params.sessionId))) {
          return this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Failed to read session' } });
        }
        const models = {
          currentModelId: this.#sessionModels.get(String(params.sessionId)) ?? MODELS.currentModelId,
          availableModels: this.resumeAvailableModels,
        };
        const result = this.resumeConfigOptions ? { models, configOptions: this.resumeConfigOptions } : { models };
        return reply(result, this.resumeGate);
      }
      case 'session/set_config_option': {
        const result = this.configReply ?? { configOptions: [{ ...MODE_OPTION, options: this.modeOptions, currentValue: params.value }] };
        return reply(result, this.configReplyGate);
      }
      case 'session/prompt':
        if (this.#openPrompt) {
          if (this.refusesOverlappingPrompts || this.#unansweredPermissions.size > 0) {
            return this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Can\'t add this prompt to session' } });
          }
          this.endPrompt();
          this.#openPrompt = { id: message.id!, sessionId: String(params.sessionId) };
          return;
        }
        this.#openPrompt = { id: message.id!, sessionId: String(params.sessionId) };
        return this.#script(this, String(params.sessionId));
      case 'session/cancel':
        if (this.cancelReply === 'immediate') return this.endPrompt('cancelled');
        if (this.cancelReply === 'deferred') setTimeout(() => this.endPrompt('cancelled'), 50);
        return;
    }
  }

  #send(message: AcpJsonRpcMessage): void {
    queueMicrotask(() => this.#stdout.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`)));
  }
}

const CONFIG: AntigravityConfig = {
  binary: () => 'agy',
  apiKey: () => null,
  authMethod: () => 'oauth-personal',
};

function harness(options: { readonly requestTimeoutMs?: number } = {}) {
  const agent = new FakeAntigravityAgent();
  const converter = new AntigravityAcpEventConverter();
  const runtime = new AcpAgentRuntime(createAntigravityAcpPolicy(CONFIG), {
    converter,
    createTransport: () => new AcpTransport({ spawn: () => agent.process(), requestTimeoutMs: options.requestTimeoutMs ?? 2_000 }),
    cancelSettleTimeoutMs: 100,
  });
  const events: AgentRuntimeEvent[] = [];
  const request = (overrides: Partial<AcpStartRequest> = {}): AcpStartRequest => ({
    chatId: 'chat-1',
    projectPath: '/work',
    model: '',
    permissionMode: 'default',
    thinkingMode: 'none',
    command: 'Do the thing.',
    operation: runtimeOperation('run-1', (event) => events.push(event)),
    ...overrides,
  });
  return { agent, runtime, events, request, converter };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > 2_000) return reject(new Error('Timed out waiting for condition'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function runEnded(events: readonly AgentRuntimeEvent[]) {
  return events.filter((event) => event.type === 'run-ended');
}

function steerRequest(runtime: AcpAgentRuntime, agentSessionId: string): RuntimeSteerRequest {
  return {
    chatId: 'chat-1',
    projectPath: '/work',
    agentSessionId,
    nativeSession: null,
    target: runtime.captureSteerTarget(agentSessionId),
    input: 'Also do this.',
    clientMessageId: 'steer-1',
    prepareDelivery: async () => {},
  };
}

describe('Antigravity ACP runtime', () => {
  it('reapplies an explicitly saved default to a turn with a bypass override', async () => {
    const { agent, runtime, events, request } = harness();
    const execution = new AcpExecution(runtime, createPathNativeSessionCodec('antigravity'));
    const saved = { permissionMode: 'default', thinkingMode: 'none', model: 'default', endpoint: null,
      settings: { ownerId: 'antigravity', schemaVersion: 1, values: {} } } as const;
    try {
      const { agentSessionId } = await runtime.startSession(request({ permissionMode: 'bypassPermissions' }));
      await execution.applySessionConfiguration(agentSessionId, { ...saved, permissionModeExplicit: true }, saved);
      agent.requestPermission(agentSessionId, 'explicit-reset');
      await waitFor(() => events.some(event => event.type === 'permission' && event.lifecycle.kind === 'requested'));
      expect(agent.received.some(frame => frame.id === 'permission-1')).toBe(false);
    } finally { runtime.shutdown(); }
  });

  it('preserves explicit approval during a cold resume when only the saved model changes', async () => {
    const { agent, runtime, events, request } = harness();
    const execution = new AcpExecution(runtime, createPathNativeSessionCodec('antigravity'));
    const saved = {
      permissionMode: 'bypassPermissions', thinkingMode: 'none', model: 'gemini-test-low',
      settings: { ownerId: 'antigravity', schemaVersion: 1, values: {} }, endpoint: null,
    } as const;
    const gate = Promise.withResolvers<void>();
    agent.sessions.add('saved');
    agent.resumeGate = gate.promise;
    agent.onPrompt((fake, id) => { fake.requestPermission(id, 'tool-1'); fake.endPrompt(); });
    try {
      const turn = runtime.runTurn({ ...request({ permissionMode: 'default' }), agentSessionId: 'saved' });
      await waitFor(() => agent.requests('session/resume').length === 1);
      await execution.applySessionConfiguration('saved', { ...saved, model: 'gemini-test-high', permissionModeExplicit: false }, saved);
      gate.resolve();
      await turn;
      expect(events.some((event) => event.type === 'permission' && event.lifecycle.kind === 'requested')).toBe(true);
      expect(agent.received.find((frame) => frame.id === 'permission-1')?.result)
        .toEqual({ outcome: { outcome: 'cancelled' } });
    } finally { runtime.shutdown(); }
  });

  it('publishes the handoff seed receipt only when the first prompt is written', async () => {
    const { agent, runtime, events } = harness();
    const execution = new AcpExecution(runtime, createPathNativeSessionCodec('antigravity'));
    const request = {
      chatId: 'chat-1', runId: 'run-1', projectPath: '/work', model: '',
      permissionMode: 'default', thinkingMode: 'none', endpoint: null, attachments: [],
      settings: { ownerId: 'antigravity', schemaVersion: 1, values: {} },
      carriedContext: { prefix: 'Selected history.\n\n' }, prompt: 'Continue.',
      admission: { signal: new AbortController().signal, markStarted: async () => {} },
    } as const;
    try {
      agent.configReply = {};
      await expect(execution.start(request, (event) => events.push(event))).rejects.toThrow('did not confirm');
      expect(agent.requests('session/prompt')).toEqual([]);
      expect(events.filter((event) => event.type === 'session')).toEqual([]);

      events.length = 0;
      agent.configReply = undefined;
      agent.onPrompt(() => { throw new Error('Synthetic prompt write failure'); });
      await expect(execution.start({ ...request, runId: 'failed-write' }, event => events.push(event))).rejects.toThrow('prompt write failure');
      expect(events.filter(event => event.type === 'session')).toEqual([]);
      agent.received.length = 0;
      events.length = 0;
      agent.onPrompt((fake) => fake.endPrompt());
      const result = await execution.start({ ...request, runId: 'run-2' }, (event) => events.push(event));
      await waitFor(() => runEnded(events).length > 0);
      expect(agent.requests('session/prompt').map((frame) => frame.params)).toEqual([{
        sessionId: result.agentSessionId, prompt: [{ type: 'text', text: 'Selected history.\n\nContinue.' }],
      }]);
      expect(events.map((event) => event.type)).toEqual(['session', 'steerable', 'run-ended']);
      expect(result.nativeSeedReceipt).toEqual(receiptForCarriedContext(request.carriedContext, result.agentSessionId));
    } finally { runtime.shutdown(); }
  });

  it('does not acknowledge a handoff when the child closes stdin before confirming its mode', async () => {
    const child = `
      import { closeSync, readSync } from 'node:fs';
      const byte = Buffer.alloc(1);
      let line = '';
      while (readSync(0, byte, 0, 1, null)) {
        if (byte[0] !== 10) { line += String.fromCharCode(byte[0]); continue; }
        const { id, method } = JSON.parse(line);
        line = '';
        if (id === undefined) continue;
        let result = {};
        if (method === 'session/new') result = { sessionId: 'synthetic' };
        if (method === 'session/set_config_option') {
          closeSync(0);
          result = { configOptions: [{ id: 'mode', currentValue: 'default' }] };
        }
        console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
        if (method === 'session/set_config_option') { await Bun.sleep(10_000); break; }
      }
    `;
    const runtime = new AcpAgentRuntime({ ...createAntigravityAcpPolicy(CONFIG), command: process.execPath, args: ['-e', child] }, {
      converter: new AntigravityAcpEventConverter(),
    });
    const execution = new AcpExecution(runtime, createPathNativeSessionCodec('antigravity'));
    const events: AgentRuntimeEvent[] = [];
    const markStarted = mock(async () => {});
    try {
      await expect(execution.start({
        chatId: 'chat', runId: 'run', projectPath: process.cwd(), model: 'default', permissionMode: 'default',
        thinkingMode: 'none', endpoint: null, attachments: [], settings: { ownerId: 'antigravity', schemaVersion: 1, values: {} },
        carriedContext: { prefix: 'Selected history.\n\n' }, prompt: 'Continue.',
        admission: { signal: new AbortController().signal, markStarted },
      }, event => events.push(event))).rejects.toThrow();
      expect(markStarted).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.type === 'session')).toEqual([]);
    } finally { runtime.shutdown(); }
  });

  it('resumes on a new pipe after a failed send without waiting for the old child to exit', async () => {
    const { agent, runtime, events, request } = harness();
    const exit = Promise.withResolvers<void>();
    const flush = Promise.withResolvers<number>();
    agent.onPrompt(fake => fake.endPrompt());
    try {
      const { agentSessionId } = await runtime.startSession(request());
      await waitFor(() => runEnded(events).length === 1);
      agent.exitAfterKill = exit.promise;
      agent.promptFlush = flush.promise;
      const resume = () => runtime.runTurn({ ...request(), agentSessionId });
      const failed = resume();
      await waitFor(() => agent.requests('session/prompt').length === 2);
      flush.reject(new Error('Prompt pipe failed'));
      await expect(failed).rejects.toThrow('Prompt pipe failed');
      expect(agent.processesKilled).toBe(1);
      agent.promptFlush = null;
      await resume();
      exit.resolve();
      await Bun.sleep(0);
      await resume();
      expect(agent.requests('session/resume').map(frame => frame.params)).toMatchObject([{ sessionId: agentSessionId }]);
      expect(runEnded(events).map(event => event.outcome)).toEqual(['finished', 'failed', 'finished', 'finished']);
    } finally { exit.resolve(); runtime.shutdown(); }
  });

  const stdoutFailures = [['idle', 'error'], ['mid-turn', 'error'], ['idle', 'EOF'], ['mid-turn', 'EOF']];
  it.each(stdoutFailures)('recovers from %s stdout %s before process exit', async (phase, failure) => {
    const { agent, runtime, events, request, converter } = harness();
    const released = spyOn(converter, 'releaseSession');
    const exit = Promise.withResolvers<void>();
    agent.exitAfterKill = exit.promise;
    try {
      const { agentSessionId } = await runtime.startSession(request());
      if (phase === 'idle') {
        agent.endPrompt();
        await waitFor(() => runEnded(events).length === 1);
      }
      if (failure === 'EOF') agent.closeStdout();
      else agent.breakStdout();
      await waitFor(() => agent.processesKilled === 1 && runEnded(events).length === 1);
      if (phase === 'mid-turn') {
        expect(released.mock.calls).toEqual([[agentSessionId]]);
        expect(runEnded(events)[0]).toMatchObject({ error: { code: 'PROVIDER_FAILURE',
          message: failure === 'EOF' ? 'ACP transport stdout closed' : 'Synthetic stdout failure' } });
        expect(events.flatMap(event => event.type === 'rows' ? event.rows.map(row => row.message.type) : [])).toEqual(['error']);
      }
      agent.onPrompt(fake => fake.endPrompt());
      const resume = (command: string) => runtime.runTurn({ ...request({ command }), agentSessionId });
      await resume('Continue on the new pipe.');
      exit.resolve();
      await Bun.sleep(0);
      await resume('After the old child exits.');
      expect(agent.requests('session/prompt').map(frame => frame.params)).toEqual(
        ['Do the thing.', 'Continue on the new pipe.', 'After the old child exits.'].map(text =>
          ({ sessionId: agentSessionId, prompt: [{ type: 'text', text }] })));
      expect(agent.requests('session/resume').map(frame => frame.params)).toMatchObject([{ sessionId: agentSessionId }]);
      expect(runEnded(events).map(event => event.outcome)).toEqual([phase === 'idle' ? 'finished' : 'failed', 'finished', 'finished']);
    } finally { exit.resolve(); runtime.shutdown(); }
  });

  it('finishes a turn whose final prompt reply ends at EOF and resumes on a fresh pipe', async () => {
    const { agent, runtime, events, request } = harness();
    try {
      const { agentSessionId } = await runtime.startSession(request());
      agent.endPromptAtEof();
      agent.crash(7);
      await waitFor(() => runEnded(events).length === 1);
      expect(runEnded(events)[0]?.outcome).toBe('finished');
      agent.onPrompt(fake => fake.endPrompt());
      await runtime.runTurn({ ...request(), agentSessionId });
      expect(agent.requests('session/resume')).toHaveLength(1);
      expect(runEnded(events).map(event => event.outcome)).toEqual(['finished', 'finished']);
    } finally { runtime.shutdown(); }
  });

  it.each(['shutdown', 'cancel'] as const)('closes an unregistered start on %s without activating it', async (cause) => {
    const { runtime, agent, request } = harness();
    const admission = new AbortController();
    const activated: string[] = [];
    const gate = Promise.withResolvers<void>();
    agent.newSessionGate = gate.promise;
    agent.onPrompt((fake) => fake.endPrompt());
    const start = runtime.startSession(request({
      executionAdmission: { signal: admission.signal, markStarted: async () => {} },
      onSessionActivated: (session) => activated.push(session.agentSessionId),
    }));
    await waitFor(() => agent.requests('session/new').length === 1);
    if (cause === 'cancel') admission.abort(new Error('admission closed'));
    else {
      runtime.shutdown();
      runtime.startPurgeTimer();
    }
    const killedBeforeReply = agent.processesKilled;
    gate.resolve();
    try {
      await expect(start).rejects.toThrow();
      expect(killedBeforeReply).toBe(1);
      expect(activated).toEqual([]);
      expect(agent.requests('session/prompt')).toEqual([]);
    } finally { runtime.shutdown(); }
  });

  it('cancels a cold restore without retaining its process or blocking a fresh turn', async () => {
    const { runtime, agent, request } = harness();
    agent.sessions.add('saved');
    const admission = new AbortController();
    const gate = Promise.withResolvers<void>();
    agent.resumeGate = gate.promise;
    const turn = runtime.runTurn({ ...request({
      executionAdmission: { signal: admission.signal, markStarted: async () => {} },
    }), agentSessionId: 'saved' });
    await waitFor(() => agent.requests('session/resume').length === 1);
    admission.abort(new Error('restore cancelled'));
    const killedBeforeReply = agent.processesKilled;
    gate.resolve();
    await expect(turn).rejects.toThrow('restore cancelled');
    expect(killedBeforeReply).toBe(1);
    expect(agent.requests('session/prompt')).toEqual([]);
    agent.resumeGate = null;
    agent.onPrompt((fake) => fake.endPrompt());
    await runtime.runTurn({ ...request(), agentSessionId: 'saved' });
    expect(agent.requests('session/resume')).toHaveLength(2);
    runtime.shutdown();
  });

  it('does not try an unadvertised load or substitute a new session when resume is unavailable', async () => {
    const { runtime, agent, request } = harness({ requestTimeoutMs: 100 });
    agent.capabilities = { sessionCapabilities: { resume: {} } };
    agent.resumeFailure = 'Method not found';
    agent.resumeErrorCode = -32601;

    await expect(runtime.runTurn({ ...request(), agentSessionId: 'saved' })).rejects.toThrow('Unable to restore');
    expect(agent.requests('session/resume')).toHaveLength(1);
    expect(agent.requests('session/load')).toEqual([]);
    expect(agent.requests('session/new')).toEqual([]);
    expect(agent.processesKilled).toBe(1);
  });

  it('never writes a prompt if admission closes while markStarted is pending', async () => {
    const { runtime, agent, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const admission = new AbortController();
    const marking = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const start = runtime.startSession(request({
      executionAdmission: { signal: admission.signal, markStarted: () => { marking.resolve(); return gate.promise; } },
    }));
    await marking.promise;
    admission.abort(new Error('admission closed'));
    gate.resolve();
    await expect(start).rejects.toThrow('admission closed');
    expect(agent.requests('session/prompt')).toEqual([]);
    runtime.shutdown();
  });

  it('closes the first process when admission ends with its configuration RPC unanswered', async () => {
    const { runtime, agent, request } = harness();
    const admission = new AbortController();
    agent.configReplyGate = new Promise(() => {});
    const start = runtime.startSession(request({
      executionAdmission: { signal: admission.signal, markStarted: async () => {} },
    }));
    await waitFor(() => agent.requests('session/set_config_option').length === 1);
    admission.abort(new Error('start cancelled'));
    expect(agent.processesKilled).toBe(1);
    await expect(start).rejects.toThrow('start cancelled');
    expect(runtime.getRunningSessions()).toEqual([]);
    expect(agent.requests('session/prompt')).toEqual([]);
  });

  it('fences both restore waiters at every handoff from native reply through prompt reservation', async () => {
    for (let handoff = 0; handoff <= 24; handoff++) {
      const { runtime, agent, request } = harness();
      const gate = Promise.withResolvers<void>();
      agent.sessions.add('saved');
      agent.resumeGate = gate.promise;
      const resume = () => runtime.runTurn({ ...request(), agentSessionId: 'saved' });
      const turns = Promise.allSettled([resume(), resume()]);
      await waitFor(() => agent.requests('session/resume').length === 1);
      gate.resolve();
      for (let i = 0; i < handoff; i++) await Promise.resolve();
      runtime.releaseSession('chat-1', 'saved');
      // Any resurrected prompt settles too, so the assertion reports the extra restore.
      agent.onPrompt((fake) => fake.endPrompt());
      await turns;
      expect(agent.requests('session/resume')).toHaveLength(1);
      runtime.shutdown();
    }
  });

  it('leaves the replacement process failure with its owning prompt', async () => {
    const { runtime, agent, request } = harness();
    agent.sessions.add('saved');
    const marking = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const retired = runtime.runTurn({ ...request({
      executionAdmission: { signal: new AbortController().signal, markStarted: () => { marking.resolve(); return gate.promise; } },
    }), agentSessionId: 'saved' });
    await marking.promise;
    runtime.releaseSession('chat-1', 'saved');

    agent.onPrompt((fake, id) => {
      fake.update(id, { sessionUpdate: 'agent_message_chunk', content: { text: '\n\u26a0 agent executor error: synthetic failure' } });
      fake.requestPermission(id, 'test-command');
    });
    const replacement = runtime.runTurn({ ...request({ permissionMode: 'manualBypass' }), agentSessionId: 'saved' });
    await waitFor(() => agent.received.some((message) => message.id === 'permission-1' && 'result' in message));
    gate.reject(new Error('Retired admission'));
    await retired;
    agent.endPrompt();
    await expect(replacement).rejects.toThrow('synthetic failure');
    runtime.shutdown();
  });

  it('lets session/new report a sign-in error when no in-band authentication is offered', async () => {
    const { agent, runtime, request } = harness();
    agent.authMethods = [];
    agent.newSessionFailure = 'Sign-in required to open session';
    try {
      await expect(runtime.startSession(request())).rejects.toThrow('Sign-in required to open session');
      expect(agent.received.map(frame => frame.method)).toEqual(['initialize', 'notifications/initialized', 'session/new']);
    } finally { runtime.shutdown(); }
  });

  it('authenticates, applies model and mode, and sends images inline', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, sessionId) => {
      fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello.' } });
      fake.endPrompt();
    });

    const started = await runtime.startSession(request({
      model: 'gemini-test-high',
      permissionMode: 'acceptEdits',
      images: [{ kind: 'image', name: 'dot.png', mimeType: 'image/png', data: 'data:image/png;base64,AAAA' }],
    }));
    await waitFor(() => runEnded(events).length === 1);

    expect(started.agentSessionId).toBe('session-1');
    expect(agent.requests('authenticate')[0]?.params).toEqual({ methodId: 'oauth-personal' });
    expect(agent.requests('session/set_model')[0]?.params).toEqual({ sessionId: 'session-1', modelId: 'gemini-test-high' });
    expect(agent.requests('session/set_config_option')[0]?.params).toEqual({
      sessionId: 'session-1', configId: 'mode', value: 'accept-edits',
    });
    expect(agent.requests('session/prompt')[0]?.params).toEqual({
      sessionId: 'session-1',
      prompt: [
        { type: 'text', text: 'Do the thing.' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ],
    });
    expect(runEnded(events)).toEqual([{
      type: 'run-ended', runId: 'run-1', outcome: 'finished', finalResponse: { type: 'text', text: 'Hello.' },
    }]);
  });

  it('publishes prose between pending tools without including it in the final response', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, id) => {
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'send', name: 'send_message', rawInput: { Recipient: 'peer' } });
      fake.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Intermediate prose' } });
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'task', name: 'manage_task', rawInput: { Action: 'kill' } });
      fake.update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final answer' } });
      fake.endPrompt();
    });
    try {
      await runtime.startSession(request());
      await waitFor(() => runEnded(events).length === 1);
      const rows = events.flatMap(event => event.type === 'rows' ? event.rows.map(row => row.message) : []);
      expect(rows.filter(row => row.type === 'assistant-message').map(row => row.content)).toEqual(['Intermediate prose', 'Final answer']);
      expect(runEnded(events)[0]).toMatchObject({ finalResponse: { type: 'text', text: 'Final answer' } });
    } finally { runtime.shutdown(); }
  });

  it('publishes pending rows separately so an aggregate flush cannot exceed the executor frame limit', async () => {
    const { agent, runtime, events, request } = harness();
    const value = 'x'.repeat(512 * 1024);
    const count = 33;
    agent.onPrompt((fake, id) => {
      for (let i = 0; i < count; i++) fake.update(id, { sessionUpdate: 'tool_call', toolCallId: `pending-${i}`, rawInput: { value } });
      fake.endPrompt();
    });
    try {
      await runtime.startSession(request());
      await waitFor(() => runEnded(events).length === 1);
      expect(events.filter(event => event.type === 'rows').map(event => event.rows.map(row => row.message)))
        .toMatchObject(Array.from({ length: count }, (_, i) => [{ toolId: `pending-${i}` }]));
    } finally { runtime.shutdown(); }
  });

  it.each(['default', 'bypassPermissions'] as const)('orders pending tools at durable but not automatic permissions (%s)', async mode => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, id) => {
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'send', name: 'send_message', rawInput: { Recipient: 'peer' } });
      fake.update(id, { sessionUpdate: 'agent_message_chunk', content: { text: 'Checking permissions' } });
      fake.requestPermission(id, 'cmd');
      fake.update(id, { sessionUpdate: 'tool_call_update', toolCallId: 'send', status: 'completed', rawInput: { Message: 'Hello' } });
      fake.endPrompt();
    });
    try {
      await runtime.startSession(request({ permissionMode: mode }));
      await waitFor(() => runEnded(events).length === 1);
      const order = events.flatMap(event => event.type === 'rows' ? event.rows.map(row => String(row.message.type)) :
        event.type === 'permission' && event.lifecycle.kind === 'requested' ? ['permission'] : []);
      expect(order).toEqual(mode === 'default'
        ? ['external-tool-use', 'assistant-message', 'permission', 'tool-result']
        : ['agent-message-tool-use', 'assistant-message', 'tool-result']);
    } finally { runtime.shutdown(); }
  });

  it('keeps a streamed answer whole across stderr while a tool is pending', async () => {
    const { agent, converter, runtime, events, request } = harness();
    const updates = spyOn(converter, 'fromSessionUpdate');
    agent.onPrompt((fake, id) => {
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'send', name: 'send_message' });
      fake.update(id, { sessionUpdate: 'agent_message_chunk', content: { text: '**Report' } });
    });
    try {
      const { agentSessionId } = await runtime.startSession(request());
      await waitFor(() => updates.mock.calls.length === 2);
      agent.stderr('Diagnostic');
      await waitFor(() => events.some(e => e.type === 'rows' && e.rows.some(r => r.message.type === 'error')));
      agent.update(agentSessionId, { sessionUpdate: 'agent_message_chunk', content: { text: ' complete**' } });
      agent.endPrompt();
      await waitFor(() => runEnded(events).length === 1);
      const rows = events.flatMap(event => event.type === 'rows' ? event.rows.map(row => row.message) : []);
      expect(rows.map(row => row.type)).toEqual(['external-tool-use', 'error', 'assistant-message']);
      expect(runEnded(events)[0]).toMatchObject({ finalResponse: { text: '**Report complete**' } });
    } finally { runtime.shutdown(); }
  });

  it('leaves the requested call and newer calls open to later identity and arguments', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, id) => {
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'first' });
      fake.update(id, { sessionUpdate: 'agent_message_chunk', content: { text: 'Before approval' } });
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'preview', title: 'Run update_steps', rawInput: { steps: [] } });
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'after', name: 'send_message', rawInput: { Recipient: 'peer' } });
      fake.requestToolPermission(id, { toolCallId: 'preview' });
    });
    try {
      const { agentSessionId } = await runtime.startSession(request());
      await waitFor(() => events.some(e => e.type === 'permission'));
      const permission = events.find(e => e.type === 'permission');
      if (!permission?.decision) throw new Error('Expected an interactive approval');
      expect(permission.lifecycle).toMatchObject({ kind: 'requested', requestedTool: { type: 'unknown-tool-use' } });
      const rows = () => events.flatMap(e => e.type === 'rows' ? e.rows.map(row => row.message) : []);
      expect(rows()).toMatchObject([{ toolId: 'first' }, { type: 'assistant-message', content: 'Before approval' }]);
      await permission.decision.respond({ allow: true });
      agent.update(agentSessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'preview', _meta: { is_mcp_tool_call: true },
        rawInput: { server: 'docs', tool: 'lookup' } });
      agent.update(agentSessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'after', rawInput: { Message: 'Hello' }, status: 'completed' });
      agent.endPrompt();
      await waitFor(() => runEnded(events).length === 1);
      expect(rows().slice(2)).toMatchObject([{ type: 'mcp-tool-use', server: 'docs' }, { type: 'agent-message-tool-use', message: 'Hello' }, { type: 'tool-result' }]);
    } finally { runtime.shutdown(); }
  });

  it('publishes unrelated pending calls before the controller can record a successful permission response', async () => {
    const { agent, converter, runtime, events, request } = harness();
    const updates = spyOn(converter, 'fromSessionUpdate');
    agent.onPrompt((fake, id) => {
      fake.requestPermission(id, 'cmd');
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'later', name: 'send_message', rawInput: { Recipient: 'peer' } });
      fake.update(id, { sessionUpdate: 'agent_message_chunk', content: { text: '**Report' } });
    });
    try {
      const { agentSessionId } = await runtime.startSession(request());
      await waitFor(() => updates.mock.calls.length === 2);
      const permission = events.find(e => e.type === 'permission');
      if (!permission?.decision) throw new Error('Expected an interactive approval');
      await permission.decision.respond({ allow: true });
      expect(events.flatMap(e => e.type === 'rows' ? e.rows.map(row => row.message) : [])).toMatchObject([{ toolId: 'later' }]);
      agent.update(agentSessionId, { sessionUpdate: 'agent_message_chunk', content: { text: ' complete**' } });
      agent.endPrompt();
      await waitFor(() => runEnded(events).length === 1);
      expect(runEnded(events)[0]).toMatchObject({ finalResponse: { text: '**Report complete**' } });
    } finally { runtime.shutdown(); }
  });

  it('does not freeze a newer plan while approving an already published command', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, id) => {
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'cmd', name: 'run_command', rawInput: { CommandLine: 'echo test' } });
      fake.update(id, { sessionUpdate: 'tool_call', toolCallId: 'plan', title: 'Run update_steps' });
      fake.requestPermission(id, 'cmd');
    });
    try {
      const { agentSessionId } = await runtime.startSession(request());
      await waitFor(() => events.some(e => e.type === 'permission'));
      const permission = events.find(e => e.type === 'permission');
      if (!permission?.decision) throw new Error('Expected an interactive approval');
      await permission.decision.respond({ allow: true });
      agent.update(agentSessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'plan', rawInput: { steps: [] }, status: 'completed' });
      agent.endPrompt();
      await waitFor(() => runEnded(events).length === 1);
      expect(events.flatMap(e => e.type === 'rows' ? e.rows.map(row => row.message.type) : []))
        .toEqual(['bash-tool-use', 'update-plan-tool-use', 'tool-result']);
    } finally { runtime.shutdown(); }
  });

  it('sends an image-only message without an empty text part', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());

    await runtime.startSession(request({
      command: '  ',
      images: [{ kind: 'image', name: 'dot.png', mimeType: 'image/png', data: 'data:image/png;base64,AAAA' }],
    }));
    await waitFor(() => runEnded(events).length === 1);

    expect((agent.requests('session/prompt')[0]?.params as { prompt: unknown }).prompt).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ]);
  });

  it('skips a model call that would not change the session but always sets the mode', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());

    await runtime.startSession(request({ model: 'gemini-test-low' }));
    await waitFor(() => runEnded(events).length === 1);

    expect(agent.requests('session/set_model')).toEqual([]);
    expect(agent.requests('session/set_config_option').map((message) => (message.params as { value: string }).value))
      .toEqual(['default']);
  });

  it('rejects a model the account does not offer before prompting', async () => {
    const { agent, runtime, request } = harness();
    await expect(runtime.startSession(request({ model: 'gemini-missing' }))).rejects.toThrow(
      'Antigravity model gemini-missing is not available for this account.',
    );
    expect(agent.requests('session/prompt')).toEqual([]);
  });

  it('answers a denial with the agent-defined deny option', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, sessionId) => fake.requestPermission(sessionId, 'tool-1'));

    await runtime.startSession(request());
    await waitFor(() => events.some((event) => event.type === 'permission'));
    const permission = events.find((event) => event.type === 'permission');
    if (permission?.type !== 'permission' || !permission.decision) throw new Error('Expected a permission request');
    expect(permission.lifecycle).toMatchObject({ kind: 'requested', requestedTool: { type: 'bash-tool-use', command: 'echo synthetic' } });

    await permission.decision.respond({ allow: false });
    await waitFor(() => agent.received.some((message) => message.id === 'permission-1'));
    expect(agent.received.find((message) => message.id === 'permission-1')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
    agent.endPrompt();
    await waitFor(() => runEnded(events).length === 1);
  });

  it('leaves non-edit requests to the user in accept-edits, where agy approves edits itself', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, sessionId) => fake.requestPermission(sessionId, 'tool-1'));

    await runtime.startSession(request({ permissionMode: 'acceptEdits' }));
    await waitFor(() => events.some((event) => event.type === 'permission'));

    expect(agent.received.some((message) => message.id === 'permission-1')).toBe(false);
    expect(agent.requests('session/set_config_option')[0]?.params).toMatchObject({ value: 'accept-edits' });
    runtime.shutdown();
  });

  it('applies the mode after a resume that reports no config options', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    agent.resumeConfigOptions = undefined;

    await runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });

    expect(agent.requests('session/set_config_option').map((message) => message.params)).toEqual([
      { sessionId: started.agentSessionId, configId: 'mode', value: 'default' },
      { sessionId: started.agentSessionId, configId: 'mode', value: 'plan' },
    ]);
    runtime.shutdown();
  });

  it('auto-approves with the allow option in bypass modes', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, sessionId) => fake.requestPermission(sessionId, 'tool-1'));

    await runtime.startSession(request({ permissionMode: 'bypassPermissions' }));
    await waitFor(() => agent.received.some((message) => message.id === 'permission-1'));
    expect(agent.received.find((message) => message.id === 'permission-1')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(events.some((event) => event.type === 'permission')).toBe(false);
    // Bypass runs in agy's default mode; the runtime answers its requests.
    expect(agent.requests('session/set_config_option').map((message) => (message.params as { value: string }).value))
      .toEqual(['default']);
    agent.endPrompt();
  });

  it('keeps the arguments an auto-approved permission request carried', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, sessionId) => {
      fake.update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', name: 'run_command', kind: 'execute', status: 'pending' });
      fake.requestPermission(sessionId, 'tool-1');
      fake.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: { output: 'synthetic' } });
      fake.endPrompt();
    });

    await runtime.startSession(request({ permissionMode: 'bypassPermissions' }));
    await waitFor(() => runEnded(events).length === 1);

    const rows = events.flatMap((event) => event.type === 'rows' ? event.rows.map((row) => row.message) : []);
    expect(rows.find((message) => message.type === 'bash-tool-use')).toMatchObject({ command: 'echo synthetic' });
    runtime.shutdown();
  });

  it('publishes no error row for a request that fails after Stop', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt(() => {});
    const started = await runtime.startSession(request());

    runtime.abort(started.agentSessionId);
    await waitFor(() => !runtime.isRunning(started.agentSessionId));
    agent.update(started.agentSessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\n⚠ agent executor error: context canceled\n' },
    });
    await Bun.sleep(10);

    const rows = events.flatMap((event) => event.type === 'rows' ? event.rows.map((row) => row.message) : []);
    expect(rows.filter((message) => message.type === 'error')).toEqual([]);
    runtime.shutdown();
  });

  it('cancels cooperatively and keeps the process for the next turn', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt(() => {});
    const started = await runtime.startSession(request());

    expect(runtime.abort(started.agentSessionId)).toBe(true);
    await waitFor(() => !runtime.isRunning(started.agentSessionId));
    const cancel = agent.requests('session/cancel')[0];
    expect(cancel).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-1' } });
    expect(runEnded(events)).toEqual([]);

    agent.onPrompt((fake) => fake.endPrompt());
    await runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    expect(agent.requests('initialize')).toHaveLength(1);
    expect(agent.requests('session/prompt')).toHaveLength(2);
  });

  it('waits for a late cancel acknowledgment before the next prompt', async () => {
    const { agent, runtime, request } = harness();
    agent.onPrompt(() => {});
    agent.cancelReply = 'deferred';
    const started = await runtime.startSession(request());

    expect(runtime.abort(started.agentSessionId)).toBe(true);
    agent.onPrompt((fake) => fake.endPrompt());
    await runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });

    expect(agent.requests('session/prompt')).toHaveLength(2);
    expect(agent.requests('initialize')).toHaveLength(1);
  });

  it('replaces the process when the agent ignores a cancel', async () => {
    const { agent, runtime, request } = harness();
    agent.onPrompt(() => {});
    agent.cancelReply = 'ignored';
    const started = await runtime.startSession(request());

    expect(runtime.abort(started.agentSessionId)).toBe(true);
    agent.onPrompt((fake) => fake.endPrompt());
    await runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });

    expect(agent.requests('initialize')).toHaveLength(2);
    expect(agent.requests('session/resume')[0]?.params).toMatchObject({ sessionId: started.agentSessionId });
    expect(agent.requests('session/prompt')).toHaveLength(2);
    runtime.shutdown();
  });

  it('retires a stopped turn the agent never settles, even without a next turn', async () => {
    const { agent, runtime, request } = harness();
    agent.onPrompt(() => {});
    agent.cancelReply = 'ignored';
    const started = await runtime.startSession(request());

    expect(runtime.abort(started.agentSessionId)).toBe(true);
    expect(runtime.isRunning(started.agentSessionId)).toBe(true);
    await waitFor(() => !runtime.isRunning(started.agentSessionId));
    expect(runtime.getRunningSessions()).toEqual([]);
  });

  it('rejects malformed mode options instead of treating them as omitted', async () => {
    const setSessionConfigOption = mock(async () => ({}));
    const wireReply = JSON.parse('{"configOptions":false}');
    await expect(applyAntigravityMode({ setSessionConfigOption }, 'session-1', wireReply.configOptions, 'plan'))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILURE', message: expect.stringContaining('config options') });
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('does not resume in an unconfirmed default mode when the native options omit mode', async () => {
    const { agent, runtime, request } = harness();
    agent.sessions.add('restored');
    agent.resumeConfigOptions = [];
    agent.configReply = {};
    agent.onPrompt((fake) => fake.endPrompt());
    await expect(runtime.runTurn({ ...request(), permissionMode: 'default', agentSessionId: 'restored' }))
      .rejects.toThrow('did not confirm');
    expect(agent.requests('session/set_config_option')[0]?.params).toMatchObject({ value: 'default' });
    expect(agent.requests('session/prompt')).toEqual([]);
    runtime.shutdown();
  });

  it('refuses a mode the session does not offer instead of running in another one', async () => {
    const { agent, runtime, request } = harness();
    agent.modeOptions = [{ value: 'default' }];
    agent.onPrompt((fake) => fake.endPrompt());

    await expect(runtime.startSession(request({ permissionMode: 'plan' }))).rejects.toThrow(
      'Antigravity does not offer the plan mode for this session.',
    );
    expect(agent.requests('session/prompt')).toEqual([]);
  });

  it('cancels permission requests that arrive after Stop instead of approving them', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt(() => {});
    agent.cancelReply = 'deferred';
    const started = await runtime.startSession(request({ permissionMode: 'bypassPermissions' }));

    runtime.abort(started.agentSessionId);
    agent.requestPermission(started.agentSessionId, 'tool-late');
    await waitFor(() => agent.received.some((message) => message.id === 'permission-1'));

    expect(agent.received.find((message) => message.id === 'permission-1')?.result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(events.some((event) => event.type === 'permission')).toBe(false);
  });

  it('approves once in bypass even when a persistent grant is offered', async () => {
    const { agent, runtime, request } = harness();
    agent.onPrompt((fake, sessionId) => fake.requestPermission(sessionId, 'tool-1', [
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'once', name: 'Once', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ]));

    await runtime.startSession(request({ permissionMode: 'bypassPermissions' }));
    await waitFor(() => agent.received.some((message) => message.id === 'permission-1'));
    expect(agent.received.find((message) => message.id === 'permission-1')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });
    runtime.shutdown();
  });

  it('sets the mode again on a turn whose cached mode already matches', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request({ permissionMode: 'plan' }));
    await waitFor(() => runEnded(events).length === 1);

    await runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });

    expect(agent.requests('session/set_config_option').map((message) => (message.params as { value: string }).value))
      .toEqual(['plan', 'plan']);
    runtime.shutdown();
  });

  it('rejects a second turn that starts while the first is still being configured', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);

    const first = runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });
    const second = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });

    await expect(second).rejects.toThrow('is already running');
    await first;
    expect(agent.requests('session/prompt')).toHaveLength(2);
    runtime.shutdown();
  });

  it('starts the next turn after Stop on a turn that runTurn started', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);

    agent.onPrompt(() => {});
    agent.cancelReply = 'deferred';
    const second = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    await waitFor(() => runtime.isRunning(started.agentSessionId) && agent.requests('session/prompt').length === 2);
    runtime.abort(started.agentSessionId);

    agent.onPrompt((fake) => fake.endPrompt());
    await runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    await second;
    expect(agent.requests('session/prompt')).toHaveLength(3);
    runtime.shutdown();
  });

  it('counts a turn that is still being configured as busy', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);

    const gate = Promise.withResolvers<void>();
    agent.configReplyGate = gate.promise;
    const turn = runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });
    await waitFor(() => agent.requests('session/set_config_option').length === 2);
    expect(agent.requests('session/prompt')).toHaveLength(1);
    expect(runtime.isRunning(started.agentSessionId)).toBe(true);
    await expect(runtime.prepareProjectPathUpdate({
      chatId: 'chat-1', agentSessionId: started.agentSessionId, previousProjectPath: '/work', nextProjectPath: '/next', nativePath: null,
    })).rejects.toThrow('is already running');
    gate.resolve();
    await turn;
    runtime.shutdown();
  });

  it('returns to the agent default model when the request names none', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request({ model: 'gemini-test-high' }));
    await waitFor(() => runEnded(events).length === 1);

    await runtime.runTurn({ ...request({ model: '' }), agentSessionId: started.agentSessionId });

    expect(agent.requests('session/set_model').map((message) => (message.params as { modelId: string }).modelId))
      .toEqual(['gemini-test-high', 'gemini-test-low']);
    runtime.shutdown();
  });

  it('remembers a model switch made before a later configuration step failed', async () => {
    const { agent, runtime, events, request } = harness();
    agent.modeOptions = [{ value: 'default' }];
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request({ model: '' }));
    await waitFor(() => runEnded(events).length === 1);

    await expect(runtime.runTurn({
      ...request({ model: 'gemini-test-high', permissionMode: 'plan' }),
      agentSessionId: started.agentSessionId,
    })).rejects.toThrow('Antigravity does not offer the plan mode for this session.');
    await runtime.runTurn({ ...request({ model: '' }), agentSessionId: started.agentSessionId });

    expect(agent.requests('session/set_model').map((message) => (message.params as { modelId: string }).modelId))
      .toEqual(['gemini-test-high', 'gemini-test-low']);
    runtime.shutdown();
  });

  it('returns to the agent default after a resumed session reports another model', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request({ model: 'gemini-test-high' }));
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);

    await runtime.runTurn({ ...request({ model: 'default' }), agentSessionId: started.agentSessionId });

    expect(agent.requests('session/resume')).toHaveLength(1);
    expect(agent.requests('session/set_model').map((message) => (message.params as { modelId: string }).modelId))
      .toEqual(['gemini-test-high', 'gemini-test-low']);
    runtime.shutdown();
  });

  it('gives a session resumed first the default a later new session reveals', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request({ model: 'gemini-test-high' }));
    await waitFor(() => runEnded(events).length === 1);
    runtime.shutdown();
    // A server restart: a new runtime whose first act is resuming the chat.
    const restarted = new AcpAgentRuntime(createAntigravityAcpPolicy(CONFIG), {
      converter: new AntigravityAcpEventConverter(),
      createTransport: () => new AcpTransport({ spawn: () => agent.process(), requestTimeoutMs: 2_000 }),
    });
    await restarted.runTurn({ ...request({ model: 'gemini-test-high' }), agentSessionId: started.agentSessionId });
    const other = await restarted.startSession(request({ chatId: 'chat-2' }));
    await waitFor(() => runEnded(events).length === 3);
    // The fake serves one process at a time, so both chats let go of theirs.
    restarted.releaseSession('chat-2', other.agentSessionId);
    restarted.releaseSession('chat-1', started.agentSessionId);

    await restarted.runTurn({ ...request(), agentSessionId: started.agentSessionId });

    expect(other.agentSessionId).not.toBe(started.agentSessionId);
    expect(agent.requests('session/set_model').map((message) => (message.params as { modelId: string }).modelId))
      .toEqual(['gemini-test-high', 'gemini-test-low']);
    restarted.shutdown();
  });

  it('keeps the current selection on Default when only a resumed model is known', async () => {
    const { agent, runtime, request } = harness();
    agent.sessions.add('restored');
    agent.onPrompt((fake) => fake.endPrompt());
    await runtime.runTurn({ ...request({ model: 'gemini-test-high' }), agentSessionId: 'restored' });
    await runtime.runTurn({ ...request({ model: 'default' }), agentSessionId: 'restored' });
    expect(agent.requests('session/new')).toHaveLength(0);
    expect(agent.requests('session/set_model').map((frame) => frame.params)).toEqual([
      { sessionId: 'restored', modelId: 'gemini-test-high' },
    ]);
    runtime.shutdown();
  });

  it.each([[MODELS.availableModels.slice(1)], [{}], [null]])('leaves a remembered default alone when the resumed list does not offer it: %j', async availableModels => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request({ model: 'gemini-test-high' }));
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    agent.resumeAvailableModels = availableModels;

    await runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });

    expect(agent.requests('session/set_model').map((message) => (message.params as { modelId: string }).modelId))
      .toEqual(['gemini-test-high']);
    expect(agent.requests('session/prompt')).toHaveLength(2);
    runtime.shutdown();
  });

  it('fails clearly when agy exits after configuration but before the prompt', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    const marked = Promise.withResolvers<void>();

    const turn = runtime.runTurn({
      ...request(),
      agentSessionId: started.agentSessionId,
      executionAdmission: { signal: new AbortController().signal, markStarted: () => marked.promise },
    }).then(() => null, (error) => error);
    await waitFor(() => agent.requests('session/set_config_option').length === 2);
    await Bun.sleep(5);
    agent.crash();
    await Bun.sleep(5);
    marked.resolve();

    expect(String(await turn)).toContain('antigravity ACP process exited before the prompt was sent');
    expect(agent.requests('session/prompt')).toHaveLength(1);
    runtime.shutdown();
  });

  it('stops the first turn while it is still being configured, before any prompt', async () => {
    const { agent, runtime, request } = harness();
    const gate = Promise.withResolvers<void>();
    agent.configReplyGate = gate.promise;
    agent.onPrompt((fake) => fake.endPrompt());

    const start = runtime.startSession(request({ permissionMode: 'plan' }));
    await waitFor(() => agent.requests('session/set_config_option').length === 1);
    expect(runtime.isRunning('session-1')).toBe(true);
    expect(runtime.abort('session-1')).toBe(true);
    gate.resolve();

    await expect(start).rejects.toThrow();
    expect(agent.requests('session/prompt')).toEqual([]);
  });

  it('delivers a cooperative Stop held until the prompt flushes', async () => {
    const { agent, runtime, request } = harness();
    const flush = Promise.withResolvers<number>();
    agent.promptFlush = flush.promise;
    try {
      const start = runtime.startSession(request());
      await waitFor(() => agent.requests('session/prompt').length === 1);
      expect(runtime.abort('session-1')).toBe(true);
      expect(agent.requests('session/cancel')).toHaveLength(0);
      flush.resolve(0);
      await start;
      await waitFor(() => !runtime.isRunning('session-1'));
      expect(agent.requests('session/cancel')).toHaveLength(1);
      expect(agent.processesKilled).toBe(0);
    } finally { runtime.shutdown(); }
  });

  it('stops waiting on a stopped turn when the follow-up itself is cancelled', async () => {
    const { agent, runtime, request } = harness();
    agent.onPrompt(() => {});
    agent.cancelReply = 'ignored';
    const started = await runtime.startSession(request());
    runtime.abort(started.agentSessionId);

    const admission = new AbortController();
    const followUp = runtime.runTurn({
      ...request(),
      agentSessionId: started.agentSessionId,
      executionAdmission: { signal: admission.signal, markStarted: async () => {} },
    });
    admission.abort(new Error('follow-up cancelled'));
    await expect(followUp).rejects.toThrow('follow-up cancelled');
    expect(agent.requests('session/prompt')).toHaveLength(1);
    runtime.shutdown();
  });

  it('shares one restore between turns that arrive together', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);

    const results = await Promise.allSettled([
      runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId }),
      runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(agent.requests('session/resume')).toHaveLength(1);
    expect(agent.requests('session/prompt')).toHaveLength(2);
    runtime.shutdown();
  });

  it('leaves no session behind when a restore fails partway', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);

    agent.resumeFailure = 'Synthetic resume failure';
    await expect(runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId })).rejects.toThrow('Synthetic resume failure');
    agent.resumeFailure = null;

    await runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    expect(agent.requests('session/resume')).toHaveLength(2);
    expect(agent.requests('session/prompt')).toHaveLength(2);
    runtime.shutdown();
  });

  it('does not mark a turn started when Stop lands while it is configured', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    const gate = Promise.withResolvers<void>();
    agent.configReplyGate = gate.promise;
    let markedStarted = false;

    const turn = runtime.runTurn({
      ...request({ permissionMode: 'plan' }),
      agentSessionId: started.agentSessionId,
      executionAdmission: { signal: new AbortController().signal, markStarted: async () => { markedStarted = true; } },
    });
    await waitFor(() => agent.requests('session/set_config_option').length === 2);
    expect(runtime.getRunningSessions()).toEqual([expect.objectContaining({ id: started.agentSessionId, status: 'running' })]);
    expect(runtime.abort(started.agentSessionId)).toBe(true);
    expect(runtime.getRunningSessions()).toEqual([expect.objectContaining({ id: started.agentSessionId, status: 'aborted' })]);
    gate.resolve();
    await turn;

    expect(markedStarted).toBe(false);
    expect(agent.requests('session/prompt')).toHaveLength(1);
    runtime.shutdown();
  });

  it('lets a prompt outlast the transport request timeout', async () => {
    const { agent, runtime, events, request } = harness({ requestTimeoutMs: 50 });
    agent.onPrompt((fake, sessionId) => setTimeout(() => {
      fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Long turn.' } });
      fake.endPrompt();
    }, 200));

    await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    expect(runEnded(events)[0]).toMatchObject({ outcome: 'finished' });
  });

  it('does not register a session whose restore was released mid-flight', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    const gate = Promise.withResolvers<void>();
    agent.resumeGate = gate.promise;

    const turn = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    await waitFor(() => agent.requests('session/resume').length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    gate.resolve();

    await expect(turn).rejects.toThrow('was released while it was being restored');
    expect(runtime.isRunning(started.agentSessionId)).toBe(false);
    expect(agent.requests('session/prompt')).toHaveLength(1);
  });

  it('retires a session whose process exits while a turn is configured', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    agent.configReplyGate = new Promise(() => {});

    const turn = runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });
    await waitFor(() => agent.requests('session/set_config_option').length === 2);
    agent.crash();
    await expect(turn).rejects.toThrow();
    agent.configReplyGate = null;

    await runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });
    expect(agent.requests('initialize')).toHaveLength(2);
    expect(agent.requests('session/resume')).toHaveLength(1);
    runtime.shutdown();
  });

  it('lets a follow-up wait for a turn stopped while it was configured', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    const gate = Promise.withResolvers<void>();
    agent.configReplyGate = gate.promise;

    const stopped = runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });
    await waitFor(() => agent.requests('session/set_config_option').length === 2);
    runtime.abort(started.agentSessionId);
    const followUp = runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });
    agent.configReplyGate = null;
    gate.resolve();

    await stopped;
    await followUp;
    expect(agent.requests('session/prompt')).toHaveLength(2);
    runtime.shutdown();
  });

  it('does not restore a session its chat released while a follow-up waited', async () => {
    const { agent, runtime, request } = harness();
    agent.onPrompt(() => {});
    agent.cancelReply = 'ignored';
    const started = await runtime.startSession(request());
    runtime.abort(started.agentSessionId);

    const followUp = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId }).then(() => null, (error) => error);
    runtime.releaseSession('chat-1', started.agentSessionId);

    expect(String(await followUp)).toContain('was released');
    expect(agent.requests('initialize')).toHaveLength(1);
    expect(agent.requests('session/prompt')).toHaveLength(1);
    runtime.shutdown();
  });

  it('applies a permission mode change made while the turn is configured', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    const gate = Promise.withResolvers<void>();
    agent.configReplyGate = gate.promise;
    agent.onPrompt((fake, sessionId) => fake.requestPermission(sessionId, 'tool-1'));

    const turn = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    await waitFor(() => agent.requests('session/set_config_option').length === 2);
    runtime.updateSessionSettings(started.agentSessionId, { permissionMode: 'bypassPermissions' });
    agent.configReplyGate = null;
    gate.resolve();
    await waitFor(() => agent.received.some((message) => message.id === 'permission-1'));

    expect(agent.received.find((message) => message.id === 'permission-1')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(events.some((event) => event.type === 'permission')).toBe(false);
    agent.endPrompt();
    await turn;
    runtime.shutdown();
  });

  it('rejects a message with neither text nor an image before spawning agy', async () => {
    const { agent, runtime, request } = harness();

    await expect(runtime.startSession(request({ command: '  ' }))).rejects.toThrow('Antigravity needs a message or an image to send.');
    expect(agent.requests('initialize')).toEqual([]);
  });

  it('rejects an unsupported attachment on start before spawning agy', async () => {
    const { agent, runtime, request } = harness();

    await expect(runtime.startSession(request({
      images: [{ kind: 'image', name: 'notes.txt', mimeType: 'text/plain', data: 'data:text/plain;base64,AAAA' }],
    }))).rejects.toThrow('Antigravity cannot attach notes.txt');
    expect(agent.requests('initialize')).toEqual([]);
  });

  it('rejects an unsupported attachment before changing the session model or mode', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);

    await expect(runtime.runTurn({
      ...request({
        model: 'gemini-test-high',
        permissionMode: 'plan',
        images: [{ kind: 'image', name: 'notes.txt', mimeType: 'text/plain', data: 'data:text/plain;base64,AAAA' }],
      }),
      agentSessionId: started.agentSessionId,
    })).rejects.toThrow('Antigravity cannot attach notes.txt');

    expect(agent.requests('session/set_model')).toEqual([]);
    expect(agent.requests('session/set_config_option')).toHaveLength(1);
    runtime.shutdown();
  });

  it('ends a configuring turn quietly when its chat is released', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    agent.configReplyGate = new Promise(() => {});

    const turn = runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });
    await waitFor(() => agent.requests('session/set_config_option').length === 2);
    runtime.releaseSession('chat-1', started.agentSessionId);

    await turn;
    expect(events.filter((event) => event.type === 'rows')).toHaveLength(0);
    expect(runEnded(events)).toHaveLength(1);
  });

  it('retires an idle session whose process dies', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);

    agent.crash();
    // Lets the transport observe the exit before the next turn looks the session up.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    expect(agent.requests('initialize')).toHaveLength(2);
    expect(agent.requests('session/resume')).toHaveLength(1);
    runtime.shutdown();
  });

  it('publishes text streamed before an unanswered Stop retires the process', async () => {
    const { agent, runtime, events, request } = harness();
    agent.cancelReply = 'ignored';
    agent.onPrompt((fake, sessionId) => {
      fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial reply.' } });
    });
    const started = await runtime.startSession(request());
    await waitFor(() => agent.requests('session/prompt').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    runtime.abort(started.agentSessionId);
    await waitFor(() => !runtime.isRunning(started.agentSessionId));
    const rows = events.flatMap((event) => event.type === 'rows' ? event.rows.map((row) => row.message) : []);
    expect(rows).toEqual([expect.objectContaining({ type: 'assistant-message', content: 'Partial reply.' })]);
  });

  it('bounds a configure call that hangs after Stop', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    agent.configReplyGate = new Promise(() => {});

    const stopped = runtime.runTurn({ ...request({ permissionMode: 'plan' }), agentSessionId: started.agentSessionId });
    await waitFor(() => agent.requests('session/set_config_option').length === 2);
    runtime.abort(started.agentSessionId);
    await stopped;
    expect(runtime.isRunning(started.agentSessionId)).toBe(false);
  });

  it('shares a replacement restore between waiters after a restore fails', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    agent.resumeFailure = 'Synthetic resume failure';

    const first = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId }).then(() => null, (error: Error) => error);
    await waitFor(() => agent.requests('session/resume').length === 1);
    agent.resumeFailure = null;
    const waiters = [1, 2].map(() => runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId }));
    expect((await first)?.message).toBe('Synthetic resume failure');
    await Promise.allSettled(waiters);

    expect(agent.requests('session/resume')).toHaveLength(2);
    runtime.shutdown();
  });

  it('does not let a waiter resurrect a session released during its restore', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    const gate = Promise.withResolvers<void>();
    agent.resumeGate = gate.promise;

    const first = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId }).then(() => null, (error: Error) => error);
    await waitFor(() => agent.requests('session/resume').length === 1);
    const waiter = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId }).then(() => null, (error: Error) => error);
    runtime.releaseSession('chat-1', started.agentSessionId);
    agent.resumeGate = null;
    gate.resolve();

    expect((await first)?.message).toContain('was released while it was being restored');
    expect((await waiter)?.message).toContain('was released while it was being restored');
    expect(agent.requests('session/resume')).toHaveLength(1);
  });

  it('does not register a session that finishes starting after shutdown', async () => {
    const { agent, runtime, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const start = runtime.startSession(request()).then(() => null, (error: Error) => error);
    runtime.shutdown();
    expect((await start)?.message).toContain('stopped while the session was starting');
    expect(agent.requests('session/prompt')).toEqual([]);
  });

  it('passes the configured Gemini API key to the agent process', () => {
    const policy = createAntigravityAcpPolicy({ ...CONFIG, apiKey: () => 'synthetic-key', authMethod: () => 'gemini-api-key' });
    expect(policy.buildEnv?.({ ...harness().request(), envOverrides: {} })?.GEMINI_API_KEY).toBe('synthetic-key');
  });

  it('reports one error row when the prompt fails after an in-band error', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, sessionId) => {
      fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ agent executor error: Error 500\n' } });
      fake.failPrompt('Synthetic prompt failure');
    });

    await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    const rows = events.flatMap((event) => event.type === 'rows' ? event.rows.map((row) => row.message) : []);
    expect(rows).toEqual([expect.objectContaining({ type: 'error', content: 'Synthetic prompt failure' })]);
  });

  it('publishes no in-band error row when Stop retires an unanswered turn', async () => {
    const { agent, runtime, events, request } = harness();
    agent.cancelReply = 'ignored';
    agent.onPrompt((fake, sessionId) => {
      fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial.\n⚠ agent executor error: cancelled upstream\n' } });
    });
    const started = await runtime.startSession(request());
    await waitFor(() => agent.requests('session/prompt').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    runtime.abort(started.agentSessionId);
    await waitFor(() => !runtime.isRunning(started.agentSessionId));
    const rows = events.flatMap((event) => event.type === 'rows' ? event.rows.map((row) => row.message.type) : []);
    expect(rows).toEqual(['assistant-message']);
  });

  it('lets a turn that arrives after a release restore the session afresh', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    const gate = Promise.withResolvers<void>();
    agent.resumeGate = gate.promise;

    const released = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId }).then(() => null, (error: Error) => error);
    await waitFor(() => agent.requests('session/resume').length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    const later = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    agent.resumeGate = null;
    gate.resolve();

    expect((await released)?.message).toContain('was released while it was being restored');
    await later;
    expect(agent.requests('session/resume')).toHaveLength(2);
    runtime.shutdown();
  });

  it('reports a session being restored as busy to project-path updates', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);
    const gate = Promise.withResolvers<void>();
    agent.resumeGate = gate.promise;

    const turn = runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });
    await waitFor(() => agent.requests('session/resume').length === 1);
    await expect(runtime.prepareProjectPathUpdate({
      chatId: 'chat-1', agentSessionId: started.agentSessionId, previousProjectPath: '/work', nextProjectPath: '/next', nativePath: null,
    })).rejects.toThrow('is being restored');
    gate.resolve();
    await turn;
    runtime.shutdown();
  });

  it('does not register a restore that starts after shutdown', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.shutdown();

    await expect(runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId })).rejects.toThrow('runtime is shutting down');
    expect(runtime.isRunning(started.agentSessionId)).toBe(false);
    expect(agent.requests('initialize')).toHaveLength(1);
    expect(agent.requests('session/prompt')).toHaveLength(1);
  });

  it('does not spawn agy for a start that arrives after shutdown', async () => {
    const { agent, runtime, request } = harness();
    runtime.shutdown();

    await expect(runtime.startSession(request())).rejects.toThrow('runtime is shutting down');
    expect(agent.requests('initialize')).toEqual([]);
  });

  it('fails the run when agy reports an executor error in-band', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake, sessionId) => {
      fake.update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n⚠ agent executor error: generating and executing: Error 429, Status: RESOURCE_EXHAUSTED\n' },
      });
      fake.endPrompt();
    });

    await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);

    const message = 'Antigravity agent executor error: generating and executing: Error 429, Status: RESOURCE_EXHAUSTED';
    expect(runEnded(events)).toEqual([{
      type: 'run-ended', runId: 'run-1', outcome: 'failed', error: { code: 'PROVIDER_FAILURE', message },
    }]);
    const rows = events.flatMap((event) => event.type === 'rows' ? event.rows.map((row) => row.message) : []);
    expect(rows.map((row) => row.type)).toEqual(['error']);
  });

  it('resumes a session in a new process after it was released', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request());
    await waitFor(() => runEnded(events).length === 1);
    runtime.releaseSession('chat-1', started.agentSessionId);

    await runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId });

    expect(agent.requests('initialize')).toHaveLength(2);
    expect(agent.requests('session/resume')[0]?.params).toEqual({ sessionId: 'session-1', cwd: '/work', mcpServers: [] });
    expect(agent.requests('session/new')).toHaveLength(1);
    runtime.shutdown();
  });

  it('folds an accepted steer into the running turn, which ends when the steer settles', async () => {
    const { agent, runtime, events, request } = harness();
    try {
      agent.onPrompt(() => {});
      const started = await runtime.startSession(request());

      const steered = await runtime.steer(steerRequest(runtime, started.agentSessionId));
      agent.update(started.agentSessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Did both.' } });
      agent.endPrompt();
      await waitFor(() => runEnded(events).length > 0);

      expect(steered).toEqual({ kind: 'accepted' });
      expect(agent.requests('session/prompt')[1]?.params).toEqual({
        sessionId: started.agentSessionId,
        prompt: [{ type: 'text', text: 'Also do this.' }],
      });
      expect(runEnded(events)).toEqual([expect.objectContaining({
        outcome: 'finished',
        finalResponse: { type: 'text', text: 'Did both.' },
      })]);
    } finally { runtime.shutdown(); }
  });

  it('delivers a steer whose turn finished while the steer was being prepared', async () => {
    const { agent, runtime, events, request } = harness();
    try {
      agent.onPrompt(() => {});
      const started = await runtime.startSession(request());
      const prepared = Promise.withResolvers<void>();
      const preparing = Promise.withResolvers<void>();

      const steering = runtime.steer({
        ...steerRequest(runtime, started.agentSessionId),
        prepareDelivery: () => {
          preparing.resolve();
          return prepared.promise;
        },
      });
      await preparing.promise;
      agent.endPrompt();
      await Bun.sleep(10);
      const endedBeforeDelivery = runEnded(events).length;
      prepared.resolve();
      const steered = await steering;
      agent.endPrompt();
      await waitFor(() => runEnded(events).length > 0);

      expect(endedBeforeDelivery).toBe(0);
      expect(steered).toEqual({ kind: 'accepted' });
      expect(agent.requests('session/prompt')).toHaveLength(2);
      expect(runEnded(events)).toEqual([expect.objectContaining({ outcome: 'finished' })]);
    } finally { runtime.shutdown(); }
  });

  it('keeps the original prompt in charge of the turn when agy refuses a steer', async () => {
    const { agent, runtime, events, request } = harness();
    try {
      agent.onPrompt(() => {});
      agent.refusesOverlappingPrompts = true;
      const started = await runtime.startSession(request());

      const steered = await runtime.steer(steerRequest(runtime, started.agentSessionId));
      const runningAfterRefusal = runtime.isRunning(started.agentSessionId);
      agent.endPrompt();
      await waitFor(() => runEnded(events).length > 0);

      expect(steered).toEqual({ kind: 'rejected', reason: 'provider-rejected', message: 'Can\'t add this prompt to session' });
      expect(runningAfterRefusal).toBe(true);
      expect(runEnded(events)).toEqual([expect.objectContaining({ outcome: 'finished' })]);
    } finally { runtime.shutdown(); }
  });

  it('offers no steering target while a permission answer is pending', async () => {
    const { agent, runtime, events, request } = harness();
    try {
      agent.onPrompt((fake, sessionId) => fake.requestPermission(sessionId, 'tool-1'));
      const started = await runtime.startSession(request());
      await waitFor(() => events.some((event) => event.type === 'permission'));
      const permission = events.find((event) => event.type === 'permission');
      if (permission?.type !== 'permission' || !permission.decision) throw new Error('Expected a permission request');

      const whilePending = runtime.captureSteerTarget(started.agentSessionId);
      await permission.decision.respond({ allow: true });

      expect(whilePending).toBeNull();
      expect(runtime.captureSteerTarget(started.agentSessionId)).not.toBeNull();
      expect(events.filter((event) => event.type === 'steerable')).toHaveLength(2);
    } finally { runtime.shutdown(); }
  });
});

describe('Antigravity one-shot query', () => {
  it.each([
    { reply: { configOptions: [{ ...MODE_OPTION, currentValue: 'default' }] }, reason: 'expected plan, got default' },
    { reply: {}, reason: 'did not confirm' },
    { reply: { configOptions: [] }, reason: 'did not confirm' },
    { reply: { configOptions: [{ id: 'mode' }] }, reason: 'did not confirm' },
    { reply: { configOptions: false }, reason: 'config options' },
  ])('sends no prompt without confirmation of plan mode: $reply', async ({ reply, reason }) => {
    const agent = new FakeAntigravityAgent();
    agent.configReply = reply;
    agent.onPrompt((fake) => fake.endPrompt());
    await expect(runAntigravitySingleQuery('Name this chat.', {
      projectPath: '/work',
      createTransport: () => new AcpTransport({ spawn: () => agent.process() }),
    }, CONFIG)).rejects.toMatchObject({ code: 'PROVIDER_FAILURE', message: expect.stringContaining(reason) });
    expect(agent.requests('session/prompt')).toEqual([]);
    expect(agent.processesKilled).toBe(1);
  });
  it('bounds the one-shot prompt by the query timeout', async () => {
    const agent = new FakeAntigravityAgent();
    agent.onPrompt(() => {});
    await expect(runAntigravitySingleQuery('Name this chat.', {
      projectPath: '/work',
      signal: new AbortController().signal,
      createTransport: () => new AcpTransport({ spawn: () => agent.process(), requestTimeoutMs: 2_000 }),
      timeoutMs: 50,
    }, CONFIG)).rejects.toThrow();
  });

  it('treats a marker followed by thoughts or tool calls as ordinary text', async () => {
    const agent = new FakeAntigravityAgent();
    agent.onPrompt((fake, sessionId) => {
      fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ agent executor error: quoted\n' } });
      fake.update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      setTimeout(() => fake.endPrompt(), 20);
    });
    const result = await runAntigravitySingleQuery('Name this chat.', {
      projectPath: '/work',
      signal: new AbortController().signal,
      createTransport: () => new AcpTransport({ spawn: () => agent.process(), requestTimeoutMs: 2_000 }),
    }, CONFIG);
    expect(result).toBe('⚠ agent executor error: quoted');
  });

  it('treats a marker followed by a call whose first frame is an update as ordinary text', async () => {
    const agent = new FakeAntigravityAgent();
    agent.onPrompt((fake, sessionId) => {
      fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ agent executor error: quoted\n' } });
      fake.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-9', status: 'in_progress' });
      setTimeout(() => fake.endPrompt(), 20);
    });
    const result = await runAntigravitySingleQuery('Name this chat.', {
      projectPath: '/work',
      signal: new AbortController().signal,
      createTransport: () => new AcpTransport({ spawn: () => agent.process(), requestTimeoutMs: 2_000 }),
    }, CONFIG);
    expect(result).toBe('⚠ agent executor error: quoted');
  });

  it('fails only when the executor error is the final output, keeping earlier text', async () => {
    const run = async (chunks: readonly string[]) => {
      const agent = new FakeAntigravityAgent();
      agent.onPrompt((fake, sessionId) => {
        for (const text of chunks) fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        setTimeout(() => fake.endPrompt(), 20);
      });
      return runAntigravitySingleQuery('Name this chat.', {
        projectPath: '/work',
        signal: new AbortController().signal,
        createTransport: () => new AcpTransport({ spawn: () => agent.process(), requestTimeoutMs: 2_000 }),
      }, CONFIG);
    };
    await expect(run(['Partial.\n⚠ agent executor error: Error 429\n'])).rejects.toThrow('Antigravity agent executor error: Error 429');
    expect(await run(['Quoted:', '\n⚠ agent executor error: x\n', 'and more.'])).toBe('Quoted:\n⚠ agent executor error: x\nand more.');
  });

  it('runs in plan mode and rejects every permission request', async () => {
    const agent = new FakeAntigravityAgent();
    agent.onPrompt((fake, sessionId) => {
      fake.requestPermission(sessionId, 'tool-1');
      fake.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Title' } });
      setTimeout(() => fake.endPrompt(), 20);
    });

    const result = await runAntigravitySingleQuery('Name this chat.', {
      projectPath: '/work',
      signal: new AbortController().signal,
      createTransport: () => new AcpTransport({ spawn: () => agent.process(), requestTimeoutMs: 2_000 }),
    }, CONFIG);

    expect(result).toBe('Title');
    expect(agent.requests('session/set_config_option')[0]?.params).toMatchObject({ configId: 'mode', value: 'plan' });
    expect(agent.received.find((message) => message.id === 'permission-1')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
  });
});
