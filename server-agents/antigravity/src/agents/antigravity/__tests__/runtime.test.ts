import { describe, expect, it } from 'bun:test';
import type { AcpJsonRpcMessage } from '@garcon/server-agent-common/acp/protocol';
import { AcpAgentRuntime } from '@garcon/server-agent-common/acp/agent-runtime';
import type { AcpStartRequest } from '@garcon/server-agent-common/acp/runtime-types';
import { AcpTransport, type AcpProcess } from '@garcon/server-agent-common/acp/transport';
import {
  runtimeOperation,
  type AgentRuntimeEvent,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { AntigravityConfig } from '../../../config.ts';
import { AntigravityAcpEventConverter } from '../antigravity-acp-event-converter.ts';
import { createAntigravityAcpPolicy } from '../antigravity-acp-policy.ts';
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
// permission option ids, `session/cancel` as a notification, and upstream
// failures reported as a message chunk followed by `end_turn`.
class FakeAntigravityAgent {
  readonly received: AcpJsonRpcMessage[] = [];
  readonly sessions = new Set<string>();
  #nextSession = 1;
  #stdout!: ReadableStreamDefaultController<Uint8Array>;
  #openPrompt: { id: number | string; sessionId: string } | null = null;
  #script: (agent: FakeAntigravityAgent, sessionId: string) => void = () => {};
  // Delays or drops the reply to `session/cancel`, as a slow or unresponsive agent would.
  cancelReply: 'immediate' | 'deferred' | 'ignored' = 'immediate';
  // Whether `session/resume` reports the session's config options.
  resumeReportsOptions = true;
  modeOptions: Array<{ value: string }> = MODE_OPTION.options;
  // Whether `session/set_config_option` replies with the session's options.
  configReplyReportsOptions = true;
  // When set, `session/resume` fails with this internal error.
  resumeFailure: string | null = null;
  // When set, `session/resume` replies only after this settles.
  resumeGate: Promise<void> | null = null;
  // When set, `session/set_config_option` replies only after this settles.
  configReplyGate: Promise<void> | null = null;

  // Each spawn is a fresh process; later frames go to the newest one.
  // Ends the newest process as a crash would.
  crash(code = 1): void {
    this.#exitCurrent?.(code);
  }

  #exitCurrent: ((code: number) => void) | null = null;

  process(): AcpProcess {
    const exited = Promise.withResolvers<number>();
    this.#exitCurrent = exited.resolve;
    return {
      stdin: { write: (data: string | Uint8Array) => this.#receive(String(data)) },
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => { this.#stdout = controller; } }),
      stderr: new ReadableStream<Uint8Array>(),
      exited: exited.promise,
      kill: () => exited.resolve(143),
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
    this.#send({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId, name: 'run_command', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'echo synthetic' } },
        options,
      },
    });
  }

  failPrompt(message: string): void {
    const prompt = this.#openPrompt;
    if (!prompt) throw new Error('No open prompt');
    this.#openPrompt = null;
    this.#send({ jsonrpc: '2.0', id: prompt.id, error: { code: -32603, message } });
  }

  endPrompt(stopReason = 'end_turn'): void {
    const prompt = this.#openPrompt;
    if (!prompt) throw new Error('No open prompt');
    this.#openPrompt = null;
    this.#send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason } });
  }

  #receive(data: string): number {
    for (const line of data.split('\n')) {
      if (line.trim()) this.#handle(JSON.parse(line) as AcpJsonRpcMessage);
    }
    return data.length;
  }

  #handle(message: AcpJsonRpcMessage): void {
    this.received.push(message);
    const params = (message.params ?? {}) as Record<string, unknown>;
    const reply = (result: unknown) => this.#send({ jsonrpc: '2.0', id: message.id, result });
    switch (message.method) {
      case 'initialize':
        return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
      case 'authenticate':
      case 'session/set_model':
        return reply({});
      case 'session/new': {
        const sessionId = `session-${this.#nextSession++}`;
        this.sessions.add(sessionId);
        return reply({ sessionId, models: MODELS, configOptions: [{ ...MODE_OPTION, options: this.modeOptions }] });
      }
      case 'session/resume':
        if (this.resumeFailure) {
          return this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: this.resumeFailure } });
        }
        if (!this.sessions.has(String(params.sessionId))) {
          return this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Failed to read session' } });
        }
      {
        const result = this.resumeReportsOptions ? { models: MODELS, configOptions: [MODE_OPTION] } : { models: MODELS };
        if (this.resumeGate) {
          void this.resumeGate.then(() => reply(result));
          return;
        }
        return reply(result);
      }
      case 'session/set_config_option':
      {
        const result = this.configReplyReportsOptions ? { configOptions: [{ ...MODE_OPTION, options: this.modeOptions, currentValue: params.value }] } : {};
        if (this.configReplyGate) {
          void this.configReplyGate.then(() => reply(result));
          return;
        }
        return reply(result);
      }
      case 'session/prompt':
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
  hasApiKey: () => false,
  authMethod: () => 'oauth-personal',
};

function harness(options: { readonly requestTimeoutMs?: number } = {}) {
  const agent = new FakeAntigravityAgent();
  const runtime = new AcpAgentRuntime(createAntigravityAcpPolicy(CONFIG), {
    converter: new AntigravityAcpEventConverter(),
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
  return { agent, runtime, events, request };
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

describe('Antigravity ACP runtime', () => {
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
    agent.resumeReportsOptions = false;

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
    const policy = createAntigravityAcpPolicy({ ...CONFIG, apiKey: () => 'synthetic-key', hasApiKey: () => true, authMethod: () => 'gemini-api-key' });
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

    await expect(runtime.runTurn({ ...request(), agentSessionId: started.agentSessionId })).rejects.toThrow('was released while it was being restored');
    expect(runtime.isRunning(started.agentSessionId)).toBe(false);
    expect(agent.requests('session/prompt')).toHaveLength(1);
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
});

describe('Antigravity one-shot query', () => {
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
