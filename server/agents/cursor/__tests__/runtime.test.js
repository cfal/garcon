import { describe, expect, it } from 'bun:test';

import {
  BashToolUseMessage,
  CursorAskQuestionToolUseMessage,
  CursorCreatePlanToolUseMessage,
  ErrorMessage,
  PermissionRequestMessage,
} from '../../../../common/chat-types.js';
import { AcpTransport } from '../../../acp/transport.js';
import { AcpAgentRuntime } from '../../shared/acp-agent-runtime.js';
import { CursorAcpEventConverter } from '../cursor-acp-event-converter.js';
import { createCursorAcpPolicy } from '../cursor-acp-policy.js';
import { runSingleQuery } from '../run-single-query.js';

function option(id, currentValue, values, extra = {}) {
  return {
    id,
    currentValue,
    options: values.map((value) => ({ value })),
    ...extra,
  };
}

function configOptionsFromState(state, overrides = {}) {
  const effective = { ...state, ...overrides };
  return [
    option('mode', effective.mode, ['agent', 'plan', 'ask'], { category: 'mode' }),
    option('model', effective.model, [
      'default',
      'composer-2.5',
      'gpt-5.5',
      'claude-opus-4-8',
    ], { category: 'model' }),
    option('context', effective.context, ['272k', '1m'], { category: 'model_config' }),
    option('reasoning', effective.reasoning, ['none', 'low', 'medium', 'high', 'extra-high'], { category: 'thought_level' }),
    option('effort', effective.effort, ['low', 'medium', 'high', 'xhigh', 'max'], { category: 'thought_level' }),
    option('thinking', effective.thinking, ['false', 'true'], { category: 'model_config' }),
    option('fast', effective.fast, ['false', 'true'], { category: 'model_config' }),
  ];
}

function createDefaultConfigState() {
  return {
    mode: 'agent',
    model: 'default',
    context: '272k',
    reasoning: 'medium',
    effort: 'medium',
    thinking: 'false',
    fast: 'false',
  };
}

function createAcpHarness(options = {}) {
  const encoder = new TextEncoder();
  const instances = [];
  const instanceWaiters = [];

  function createInstance() {
    let stdoutController;
    let exitResolve;
    let promptRequestId = null;
    const configState = createDefaultConfigState();
    let closed = false;
    let killed = false;
    const writes = [];
    const writeWaiters = [];

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
    const exited = new Promise((resolve) => {
      exitResolve = resolve;
    });

    function resolveWriteWaiters(message) {
      for (let i = writeWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = writeWaiters[i];
        if (!waiter.predicate(message)) continue;
        writeWaiters.splice(i, 1);
        waiter.resolve(message);
      }
    }

    function emit(message) {
      if (closed) return;
      stdoutController.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    }

    function handleClientMessage(message) {
      writes.push(message);
      resolveWriteWaiters(message);

      if (message.method === 'initialize') {
        emit({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { load: true },
            },
          },
        });
        return;
      }

      if (message.method === 'authenticate') {
        emit({ jsonrpc: '2.0', id: message.id, result: {} });
        return;
      }

      if (message.method === 'session/new') {
        emit({
          jsonrpc: '2.0',
          id: message.id,
          result: { sessionId: 'cursor-session', configOptions: configOptionsFromState(configState) },
        });
        return;
      }

      if (message.method === 'session/load' || message.method === 'session/resume') {
        emit({ jsonrpc: '2.0', id: message.id, result: { configOptions: configOptionsFromState(configState) } });
        return;
      }

      if (message.method === 'session/set_config_option') {
        configState[message.params.configId] = message.params.value;
        const mismatch = options.configMismatch?.configId === message.params.configId
          ? { [message.params.configId]: options.configMismatch.currentValue }
          : {};
        emit({
          jsonrpc: '2.0',
          id: message.id,
          result: { configOptions: configOptionsFromState(configState, mismatch) },
        });
        return;
      }

      if (message.method === 'session/prompt') {
        promptRequestId = message.id;
        return;
      }

      if (message.method === 'session/cancel') {
        emit({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    }

    function close(exitCode = 0) {
      if (closed) return;
      closed = true;
      stdoutController.close();
      exitResolve(exitCode);
    }

    const instance = {
      get killed() {
        return killed;
      },
      writes,
      process: {
        stdin: {
          write(data) {
            for (const line of String(data).split('\n')) {
              if (!line.trim()) continue;
              handleClientMessage(JSON.parse(line));
            }
          },
          end() {},
        },
        stdout,
        stderr,
        exited,
        kill() {
          killed = true;
          close(143);
        },
      },
      serverRequest(message) {
        emit({ jsonrpc: '2.0', ...message });
      },
      sessionUpdate(update) {
        emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'cursor-session', update },
        });
      },
      finishPrompt() {
        if (promptRequestId === null) throw new Error('session/prompt was not received');
        emit({
          jsonrpc: '2.0',
          id: promptRequestId,
          result: { stopReason: 'end_turn', requestId: 'cursor-request-1' },
        });
      },
      waitForWrite(predicate) {
        const existing = writes.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve) => {
          writeWaiters.push({ predicate, resolve });
        });
      },
      waitForClientMethod(method) {
        return this.waitForWrite((message) => message.method === method);
      },
      waitForExit() {
        return exited;
      },
    };

    instances.push(instance);
    for (let i = instanceWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = instanceWaiters[i];
      if (instances[waiter.index] !== instance) continue;
      instanceWaiters.splice(i, 1);
      waiter.resolve(instance);
    }
    return instance;
  }

  function currentInstance() {
    const instance = instances.at(-1);
    if (!instance) throw new Error('ACP process has not been spawned');
    return instance;
  }

  return {
    get writes() {
      return instances.flatMap((instance) => instance.writes);
    },
    createTransport() {
      return new AcpTransport({
        spawn: () => createInstance().process,
      });
    },
    instance(index) {
      const instance = instances[index];
      if (!instance) throw new Error(`ACP process ${index} has not been spawned`);
      return instance;
    },
    waitForInstance(index) {
      const instance = instances[index];
      if (instance) return Promise.resolve(instance);
      return new Promise((resolve) => {
        instanceWaiters.push({ index, resolve });
      });
    },
    killCount() {
      return instances.filter((instance) => instance.killed).length;
    },
    serverRequest(message) {
      currentInstance().serverRequest(message);
    },
    sessionUpdate(update) {
      currentInstance().sessionUpdate(update);
    },
    finishPrompt() {
      currentInstance().finishPrompt();
    },
    waitForWrite(predicate) {
      const existing = this.writes.find(predicate);
      if (existing) return Promise.resolve(existing);
      return currentInstance().waitForWrite(predicate);
    },
    waitForClientMethod(method) {
      return this.waitForWrite((message) => message.method === method);
    },
  };
}

function startRequest(overrides = {}) {
  return {
    chatId: 'chat-1',
    command: 'do work',
    projectPath: '/tmp/project',
    model: 'default',
    permissionMode: 'default',
    thinkingMode: 'none',
    ...overrides,
  };
}

function createRuntimeHarness(options = {}) {
  const acp = createAcpHarness(options);
  const runtime = new AcpAgentRuntime(createCursorAcpPolicy(), {
    converter: new CursorAcpEventConverter(),
    createTransport: acp.createTransport,
  });
  const messages = [];
  const messageWaiters = [];

  runtime.onMessages((_chatId, incoming) => {
    messages.push(...incoming);
    for (let i = messageWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = messageWaiters[i];
      const match = messages.find(waiter.predicate);
      if (!match) continue;
      messageWaiters.splice(i, 1);
      waiter.resolve(match);
    }
  });

  return {
    acp,
    runtime,
    messages,
    waitForMessage(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        messageWaiters.push({ predicate, resolve });
      });
    },
  };
}

describe('Cursor ACP runtime', () => {
  it('advertises Cursor parameterized model support during ACP initialization', async () => {
    const { acp, runtime } = createRuntimeHarness();
    await runtime.startSession(startRequest());

    const initialize = acp.writes.find((message) => message.method === 'initialize');
    expect(initialize.params.clientCapabilities).toEqual({
      _meta: { parameterizedModelPicker: true },
    });

    await acp.waitForClientMethod('session/prompt');
    acp.finishPrompt();
    runtime.shutdown();
  });

  it('configures the selected Cursor model through ACP config options before prompting', async () => {
    const { acp, runtime } = createRuntimeHarness();
    await runtime.startSession(startRequest({ model: 'gpt-5.5-extra-high' }));

    const prompt = await acp.waitForClientMethod('session/prompt');
    const setConfigCalls = acp.writes.filter((message) => message.method === 'session/set_config_option');
    expect(setConfigCalls.map((message) => message.params)).toEqual([
      { sessionId: 'cursor-session', configId: 'mode', value: 'agent' },
      { sessionId: 'cursor-session', configId: 'model', value: 'gpt-5.5' },
      { sessionId: 'cursor-session', configId: 'context', value: '1m' },
      { sessionId: 'cursor-session', configId: 'reasoning', value: 'extra-high' },
      { sessionId: 'cursor-session', configId: 'fast', value: 'false' },
    ]);

    const methods = acp.writes.map((message) => message.method);
    expect(methods.indexOf('session/set_config_option')).toBeLessThan(methods.indexOf('session/prompt'));
    expect(prompt.params.config).toBeUndefined();

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('fails before prompting when Cursor reports a model config mismatch', async () => {
    const { acp, runtime, waitForMessage } = createRuntimeHarness({
      configMismatch: { configId: 'reasoning', currentValue: 'medium' },
    });
    await runtime.startSession(startRequest({ model: 'gpt-5.5-extra-high' }));

    const error = await waitForMessage((message) => message instanceof ErrorMessage);
    expect(error.content).toContain('Cursor did not apply requested model gpt-5.5-extra-high');
    expect(acp.writes.some((message) => message.method === 'session/prompt')).toBe(false);

    runtime.shutdown();
  });

  it('kills the Cursor ACP process and marks the session idle immediately on abort', async () => {
    const { acp, runtime } = createRuntimeHarness();
    const started = await runtime.startSession(startRequest());
    await acp.waitForClientMethod('session/prompt');

    expect(runtime.isRunning(started.agentSessionId)).toBe(true);
    expect(runtime.abort(started.agentSessionId)).toBe(true);

    expect(runtime.isRunning(started.agentSessionId)).toBe(false);
    expect(acp.killCount()).toBe(1);

    runtime.shutdown();
  });

  it('reconnects after abort and sends the next prompt to Cursor', async () => {
    const { acp, runtime } = createRuntimeHarness();
    const started = await runtime.startSession(startRequest({ command: 'first message', model: 'gpt-5.5-extra-high' }));
    await acp.waitForClientMethod('session/prompt');

    expect(runtime.abort(started.agentSessionId)).toBe(true);

    const nextTurn = runtime.runTurn(startRequest({
      agentSessionId: started.agentSessionId,
      command: 'second message',
      model: 'gpt-5.5-extra-high',
    }));
    const restarted = await acp.waitForInstance(1);
    const load = await restarted.waitForClientMethod('session/load');
    expect(load.params.sessionId).toBe(started.agentSessionId);

    const prompt = await restarted.waitForClientMethod('session/prompt');
    expect(prompt.params.prompt).toEqual([{ type: 'text', text: 'second message' }]);
    const methods = restarted.writes.map((message) => message.method);
    expect(methods.indexOf('session/load')).toBeLessThan(methods.indexOf('session/set_config_option'));
    expect(methods.indexOf('session/set_config_option')).toBeLessThan(methods.indexOf('session/prompt'));

    restarted.finishPrompt();
    await nextTurn;
    runtime.shutdown();
  });

  it('emits standard ACP permission requests and responds with selected option outcomes', async () => {
    const { acp, runtime, waitForMessage } = createRuntimeHarness();
    const started = await runtime.startSession(startRequest());

    expect(started).toEqual({
      agentSessionId: 'cursor-session',
      nativePath: '!cursor-acp:cursor-session',
    });

    await acp.waitForClientMethod('session/prompt');
    acp.serverRequest({
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'cursor-session',
        toolCall: {
          toolCallId: 'tool-1',
          toolName: 'Bash',
          rawInput: { command: 'echo hello' },
        },
        options: [{ optionId: 'allow-once' }, { optionId: 'reject-once' }],
      },
    });

    const request = await waitForMessage((message) => message instanceof PermissionRequestMessage);
    expect(request.requestedTool).toBeInstanceOf(BashToolUseMessage);
    expect(request.requestedTool.command).toBe('echo hello');

    runtime.resolvePermission(request.permissionRequestId, { allow: true });
    const response = await acp.waitForWrite((message) => message.id === 'permission-1' && message.result);
    expect(response.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('auto-approves standard ACP permission requests in manual bypass without emitting a row', async () => {
    const { acp, runtime, messages } = createRuntimeHarness();
    await runtime.startSession(startRequest({ permissionMode: 'manualBypass' }));
    await acp.waitForClientMethod('session/prompt');

    acp.serverRequest({
      id: 'permission-manual',
      method: 'session/request_permission',
      params: {
        sessionId: 'cursor-session',
        toolCall: {
          toolCallId: 'tool-1',
          toolName: 'Bash',
          rawInput: { command: 'echo hello' },
        },
        options: [{ optionId: 'allow-once' }, { optionId: 'allow-always' }, { optionId: 'reject-once' }],
      },
    });

    const response = await acp.waitForWrite((message) => message.id === 'permission-manual' && message.result);
    expect(response.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(messages.some((message) => message instanceof PermissionRequestMessage)).toBe(false);

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('uses live manual bypass setting updates for subsequent ACP permission requests', async () => {
    const { acp, runtime, messages } = createRuntimeHarness();
    const started = await runtime.startSession(startRequest());
    await acp.waitForClientMethod('session/prompt');

    runtime.updateSessionSettings(started.agentSessionId, { permissionMode: 'manualBypass' });
    acp.serverRequest({
      id: 'permission-updated',
      method: 'session/request_permission',
      params: {
        sessionId: 'cursor-session',
        toolCall: {
          toolCallId: 'tool-1',
          toolName: 'Bash',
          rawInput: { command: 'echo hello' },
        },
        options: [{ optionId: 'allow-once' }, { optionId: 'reject-once' }],
      },
    });

    const response = await acp.waitForWrite((message) => message.id === 'permission-updated' && message.result);
    expect(response.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(messages.some((message) => message instanceof PermissionRequestMessage)).toBe(false);

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('emits Cursor ask-question requests and forwards answered responses', async () => {
    const { acp, runtime, waitForMessage } = createRuntimeHarness();
    await runtime.startSession(startRequest());
    await acp.waitForClientMethod('session/prompt');

    acp.serverRequest({
      id: 'question-1',
      method: 'cursor/ask_question',
      params: {
        toolCallId: 'call-question',
        title: 'Need input',
        questions: [{
          id: 'q1',
          prompt: 'Which mode?',
          options: [{ id: 'agent', label: 'Agent' }],
        }],
      },
    });

    const request = await waitForMessage((message) => message instanceof PermissionRequestMessage);
    expect(request.requestedTool).toBeInstanceOf(CursorAskQuestionToolUseMessage);
    expect(request.requestedTool.questions[0].prompt).toBe('Which mode?');

    const answered = {
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['agent'] }],
      },
    };
    runtime.resolvePermission(request.permissionRequestId, { allow: true, response: answered });

    const response = await acp.waitForWrite((message) => message.id === 'question-1' && message.result);
    expect(response.result).toEqual(answered);

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('emits Cursor create-plan requests and can reject them', async () => {
    const { acp, runtime, waitForMessage } = createRuntimeHarness();
    await runtime.startSession(startRequest());
    await acp.waitForClientMethod('session/prompt');

    acp.serverRequest({
      id: 'plan-1',
      method: 'cursor/create_plan',
      params: {
        toolCallId: 'call-plan',
        name: 'Refactor',
        plan: 'Do the work',
        todos: [{ id: 'todo-1', content: 'Inspect', status: 'pending' }],
      },
    });

    const request = await waitForMessage((message) => message instanceof PermissionRequestMessage);
    expect(request.requestedTool).toBeInstanceOf(CursorCreatePlanToolUseMessage);
    expect(request.requestedTool.plan).toBe('Do the work');

    runtime.resolvePermission(request.permissionRequestId, { allow: false });
    const response = await acp.waitForWrite((message) => message.id === 'plan-1' && message.result);
    expect(response.result).toEqual({
      outcome: { outcome: 'rejected', reason: 'User rejected plan' },
    });

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('rejects permissions in noninteractive Cursor single-query mode without hanging', async () => {
    const acp = createAcpHarness();
    const query = runSingleQuery('hello', { model: 'gpt-5.5-extra-high', createTransport: acp.createTransport });
    const prompt = await acp.waitForClientMethod('session/prompt');

    const setConfigCalls = acp.writes.filter((message) => message.method === 'session/set_config_option');
    expect(setConfigCalls.map((message) => message.params)).toEqual([
      { sessionId: 'cursor-session', configId: 'mode', value: 'ask' },
      { sessionId: 'cursor-session', configId: 'model', value: 'gpt-5.5' },
      { sessionId: 'cursor-session', configId: 'context', value: '1m' },
      { sessionId: 'cursor-session', configId: 'reasoning', value: 'extra-high' },
      { sessionId: 'cursor-session', configId: 'fast', value: 'false' },
    ]);
    expect(prompt.params.config).toBeUndefined();

    acp.serverRequest({
      id: 'permission-single',
      method: 'session/request_permission',
      params: {
        sessionId: 'cursor-session',
        toolCall: { toolCallId: 'tool-1', toolName: 'Bash', rawInput: { command: 'echo hello' } },
      },
    });
    const permissionResponse = await acp.waitForWrite((message) => message.id === 'permission-single' && message.result);
    expect(permissionResponse.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });

    acp.sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'Hello from Cursor' },
    });
    acp.finishPrompt();

    expect(await query).toBe('Hello from Cursor');
  });
});
