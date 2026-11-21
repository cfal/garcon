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

  // Each spawn is a fresh process; later frames go to the newest one.
  process(): AcpProcess {
    const exited = Promise.withResolvers<number>();
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
        if (!this.sessions.has(String(params.sessionId))) {
          return this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Failed to read session' } });
        }
        return reply(this.resumeReportsOptions ? { models: MODELS, configOptions: [MODE_OPTION] } : { models: MODELS });
      case 'session/set_config_option':
        return reply(this.configReplyReportsOptions ? { configOptions: [{ ...MODE_OPTION, currentValue: params.value }] } : {});
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
  hasApiKey: () => false,
  authMethod: () => 'oauth-personal',
};

function harness() {
  const agent = new FakeAntigravityAgent();
  const runtime = new AcpAgentRuntime(createAntigravityAcpPolicy(CONFIG), {
    converter: new AntigravityAcpEventConverter(),
    createTransport: () => new AcpTransport({ spawn: () => agent.process(), requestTimeoutMs: 2_000 }),
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

  it('skips model and mode calls that would not change the session', async () => {
    const { agent, runtime, events, request } = harness();
    agent.onPrompt((fake) => fake.endPrompt());

    await runtime.startSession(request({ model: 'gemini-test-low' }));
    await waitFor(() => runEnded(events).length === 1);

    expect(agent.requests('session/set_model')).toEqual([]);
    expect(agent.requests('session/set_config_option')).toEqual([]);
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
    expect(agent.requests('session/set_config_option')).toEqual([]);
    agent.endPrompt();
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

  it('switches back to a mode when the config reply omitted the options', async () => {
    const { agent, runtime, events, request } = harness();
    agent.configReplyReportsOptions = false;
    agent.onPrompt((fake) => fake.endPrompt());
    const started = await runtime.startSession(request({ permissionMode: 'plan' }));
    await waitFor(() => runEnded(events).length === 1);

    await runtime.runTurn({ ...request({ permissionMode: 'default' }), agentSessionId: started.agentSessionId });

    expect(agent.requests('session/set_config_option').map((message) => (message.params as { value: string }).value))
      .toEqual(['plan', 'default']);
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
