import { describe, expect, it, mock } from 'bun:test';

import {
  BashToolUseMessage,
  CursorAskQuestionToolUseMessage,
  CursorCreatePlanToolUseMessage,
  ErrorMessage,
} from '@garcon/common/chat-types';
import { AcpTransport } from '../../../acp/transport.js';
import { AcpAgentRuntime } from '../../shared/acp-agent-runtime.js';
import { CursorAcpEventConverter } from '../cursor-acp-event-converter.js';
import { createCursorAcpPolicy } from '../cursor-acp-policy.js';
import { runSingleQuery } from '../run-single-query.js';

const TEST_CURSOR_CONFIG = {
  binary: () => 'cursor-agent',
  apiKey: () => null,
};
const PERMISSION_OCCURRENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function noopOperation(runId = 'run-default') {
  return { runId, publish() {} };
}

function collectOperation(runId) {
  const events = [];
  const waiters = [];
  return {
    events,
    operation: {
      runId,
      publish(event) {
        events.push(event);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          const waiter = waiters[i];
          if (!waiter.predicate(event)) continue;
          waiters.splice(i, 1);
          waiter.resolve(event);
        }
      },
    },
    waitForEvent(predicate) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

function publishedMessages(events) {
  return events.flatMap((event) => (
    event.type === 'rows' ? event.rows.map((row) => row.message) : []
  ));
}

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
    const instanceIndex = instances.length;
    const sessionId = options.sessionIds?.[instanceIndex] ?? 'cursor-session';
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
          result: { sessionId, configOptions: configOptionsFromState(configState) },
        });
        return;
      }

      if (message.method === 'session/load' || message.method === 'session/resume') {
        emit({ jsonrpc: '2.0', id: message.id, result: { configOptions: configOptionsFromState(configState) } });
        return;
      }

      if (message.method === 'session/set_config_option') {
        configState[message.params.configId] = message.params.value;
        const mismatchApplies = options.configMismatch?.instanceIndex === undefined
          || options.configMismatch.instanceIndex === instanceIndex;
        const mismatch = mismatchApplies && options.configMismatch?.configId === message.params.configId
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
          if (!options.keepKilledStreamOpen) close(143);
        },
      },
      close,
      serverRequest(message) {
        emit({ jsonrpc: '2.0', ...message });
      },
      sessionUpdate(update) {
        emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update },
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
    operation: noopOperation(),
    ...overrides,
  };
}

function createRuntimeHarness(options = {}) {
  const acp = createAcpHarness(options);
  const runtime = new AcpAgentRuntime(createCursorAcpPolicy(TEST_CURSOR_CONFIG), {
    converter: new CursorAcpEventConverter(),
    createTransport: acp.createTransport,
    logger: options.logger,
  });

  return {
    acp,
    runtime,
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
    const { acp, runtime } = createRuntimeHarness({
      configMismatch: { configId: 'reasoning', currentValue: 'medium' },
    });
    const published = collectOperation('run-mismatch');
    await expect(runtime.startSession(startRequest({
      model: 'gpt-5.5-extra-high',
      operation: published.operation,
    })))
      .rejects.toThrow('Cursor did not apply requested model gpt-5.5-extra-high');

    const error = publishedMessages(published.events)
      .find((message) => message instanceof ErrorMessage);
    expect(error.content).toContain('Cursor did not apply requested model gpt-5.5-extra-high');
    expect(acp.writes.some((message) => message.method === 'session/prompt')).toBe(false);

    runtime.shutdown();
  });

  it('[TLV5-L07.07-CURSOR-UNIT-01] keeps an established publisher when a fresh session fails before prompting', async () => {
    const first = collectOperation('run-established');
    const replacement = collectOperation('run-failed-replacement');
    const { acp, runtime } = createRuntimeHarness({
      sessionIds: ['cursor-established', 'cursor-replacement'],
      configMismatch: {
        instanceIndex: 1,
        configId: 'reasoning',
        currentValue: 'medium',
      },
    });
    await runtime.startSession(startRequest({ operation: first.operation }));
    const established = acp.instance(0);
    await established.waitForClientMethod('session/prompt');
    established.finishPrompt();
    await first.waitForEvent((event) => event.type === 'run-ended');

    await expect(runtime.startSession(startRequest({
      model: 'gpt-5.5-extra-high',
      operation: replacement.operation,
    }))).rejects.toThrow('Cursor did not apply requested model gpt-5.5-extra-high');

    established.sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'still belongs to the established source' },
    });
    const late = await first.waitForEvent((event) => (
      event.type === 'rows'
      && JSON.stringify(event).includes('still belongs to the established source')
    ));
    expect(JSON.stringify(late)).toContain('still belongs to the established source');
    expect(JSON.stringify(replacement.events)).not.toContain('still belongs to the established source');
    runtime.shutdown();
  });

  it('[TLV5-L07.03-CURSOR-UNIT-01] binds each sequential prompt to its concrete publisher through source retirement', async () => {
    const first = collectOperation('run-a');
    const second = collectOperation('run-b');
    const { acp, runtime } = createRuntimeHarness();
    const started = await runtime.startSession(startRequest({ operation: first.operation }));
    const client = acp.instance(0);
    await client.waitForClientMethod('session/prompt');
    client.finishPrompt();
    await first.waitForEvent((event) => event.type === 'run-ended');

    client.sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'late A output' },
    });
    await first.waitForEvent((event) => (
      event.type === 'rows' && JSON.stringify(event).includes('late A output')
    ));

    const nextTurn = runtime.runTurn(startRequest({
      agentSessionId: started.agentSessionId,
      command: 'next prompt',
      operation: second.operation,
    }));
    await client.waitForWrite((message) => (
      message.method === 'session/prompt'
      && message.params.prompt[0]?.text === 'next prompt'
    ));
    client.sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'B output' },
    });
    client.finishPrompt();
    await nextTurn;

    expect(first.events.map((event) => event.type)).toEqual(['run-ended', 'rows']);
    expect(JSON.stringify(first.events)).not.toContain('B output');
    expect(second.events.map((event) => event.type)).toEqual(['rows', 'run-ended']);
    expect(JSON.stringify(second.events)).not.toContain('late A output');
    runtime.shutdown();
  });

  it('[TLV5-L07.04-CURSOR-UNIT-01] rejects cross-chat native session collisions without rebinding the original source', async () => {
    const first = collectOperation('run-chat-a');
    const colliding = collectOperation('run-chat-b');
    const { acp, runtime } = createRuntimeHarness({
      sessionIds: ['shared-cursor-session', 'shared-cursor-session'],
    });
    await runtime.startSession(startRequest({
      chatId: 'chat-a',
      operation: first.operation,
    }));
    const original = acp.instance(0);
    await original.waitForClientMethod('session/prompt');
    original.finishPrompt();
    await first.waitForEvent((event) => event.type === 'run-ended');

    await expect(runtime.startSession(startRequest({
      chatId: 'chat-b',
      operation: colliding.operation,
    }))).rejects.toThrow('already bound to another chat');

    original.sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'only chat A receives this' },
    });
    await first.waitForEvent((event) => (
      event.type === 'rows' && JSON.stringify(event).includes('only chat A receives this')
    ));
    expect(colliding.events).toEqual([]);
    runtime.shutdown();
  });

  it('[TLV5-L07.05-CURSOR-UNIT-01] logs and drops session updates without a native session identity', async () => {
    const logger = {
      debug: mock(),
      info: mock(),
      warn: mock(),
      error: mock(),
    };
    const operation = collectOperation('run-named');
    const { acp, runtime } = createRuntimeHarness({ logger });
    await runtime.startSession(startRequest({ operation: operation.operation }));
    await acp.waitForClientMethod('session/prompt');

    acp.serverRequest({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'must be dropped' },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.stringify(operation.events)).not.toContain('must be dropped');
    expect(operation.events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Dropped an ACP session update without its owning native session.',
      { agentId: 'cursor', sessionId: 'cursor-session' },
    );
    acp.finishPrompt();
    await operation.waitForEvent((event) => event.type === 'run-ended');
    runtime.shutdown();
  });

  it('rejects a start cancelled during configuration without sending a prompt', async () => {
    const acp = createAcpHarness();
    const configurationStarted = deferred();
    const continueConfiguration = deferred();
    const policy = {
      ...createCursorAcpPolicy(TEST_CURSOR_CONFIG),
      async configureSession() {
        configurationStarted.resolve();
        await continueConfiguration.promise;
        return [];
      },
    };
    const runtime = new AcpAgentRuntime(policy, {
      converter: new CursorAcpEventConverter(),
      createTransport: acp.createTransport,
    });
    const admission = new AbortController();
    const start = runtime.startSession(startRequest({
      executionAdmission: {
        signal: admission.signal,
        markStarted: mock(),
      },
    }));
    await configurationStarted.promise;

    admission.abort(new Error('server shutting down'));
    continueConfiguration.resolve();

    await expect(start).rejects.toThrow('server shutting down');
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

  it('[TLV5-L07.08-CURSOR-UNIT-01] ignores buffered updates from a retired ACP client after reconnect', async () => {
    const { acp, runtime } = createRuntimeHarness({ keepKilledStreamOpen: true });
    const first = collectOperation('run-a');
    const second = collectOperation('run-b');
    const started = await runtime.startSession(startRequest({
      command: 'first message',
      operation: first.operation,
    }));
    await acp.waitForClientMethod('session/prompt');
    const retired = acp.instance(0);

    expect(runtime.abort(started.agentSessionId)).toBe(true);
    const nextTurn = runtime.runTurn(startRequest({
      agentSessionId: started.agentSessionId,
      command: 'second message',
      operation: second.operation,
    }));
    const restarted = await acp.waitForInstance(1);
    await restarted.waitForClientMethod('session/prompt');

    retired.sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'late output from A' },
    });
    retired.serverRequest({
      id: 'late-permission-a',
      method: 'session/request_permission',
      params: {
        sessionId: started.agentSessionId,
        toolCall: { toolCallId: 'late-tool', toolName: 'Bash', rawInput: { command: 'echo stale' } },
        options: [{ optionId: 'allow-once' }, { optionId: 'reject-once' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.events).toEqual([]);
    expect(second.events).toEqual([]);

    restarted.finishPrompt();
    await nextTurn;
    expect(second.events.map((event) => event.type)).toEqual(['run-ended']);
    retired.close(143);
    runtime.shutdown();
  });

  it('emits standard ACP permission requests and responds with selected option outcomes', async () => {
    const { acp, runtime } = createRuntimeHarness();
    const operation = collectOperation('run-1');
    const started = await runtime.startSession(startRequest({ operation: operation.operation }));

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

    const permission = await operation.waitForEvent((event) => event.type === 'permission');
    const request = permission.lifecycle;
    expect(request.requestedTool).toBeInstanceOf(BashToolUseMessage);
    expect(request.requestedTool.command).toBe('echo hello');
    expect(permission).toMatchObject({
      runId: 'run-1',
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: request.permissionOccurrenceId,
      },
    });
    await permission.decision.respond({ allow: true });
    const response = await acp.waitForWrite((message) => message.id === 'permission-1' && message.result);
    expect(response.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('[TLV5-PERM.01-CURSOR-UNIT-01] [TLV5-PERM.04-CURSOR-UNIT-01] keeps reused ACP request ids bound to separate permission capabilities', async () => {
    const { acp, runtime } = createRuntimeHarness();
    const operation = collectOperation('run-1');
    await runtime.startSession(startRequest({ operation: operation.operation }));
    await acp.waitForClientMethod('session/prompt');
    const request = () => acp.serverRequest({
      id: 'permission-reused',
      method: 'session/request_permission',
      params: {
        sessionId: 'cursor-session',
        toolCall: {
          toolCallId: 'tool-reused',
          toolName: 'Bash',
          rawInput: { command: 'echo hello' },
        },
        options: [{ optionId: 'allow-once' }, { optionId: 'reject-once' }],
      },
    });

    request();
    const first = await operation.waitForEvent((event) => event.type === 'permission');
    request();
    const second = await operation.waitForEvent((event) => (
      event.type === 'permission'
      && event.lifecycle.permissionOccurrenceId !== first.lifecycle.permissionOccurrenceId
    ));

    expect(first.lifecycle.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
    expect(second.lifecycle.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
    expect(first.lifecycle.permissionOccurrenceId).not.toBe('permission-reused');
    expect(second.lifecycle.permissionOccurrenceId).not.toBe(
      first.lifecycle.permissionOccurrenceId,
    );
    await first.decision.respond({ allow: true });
    await expect(first.decision.respond({ allow: false }))
      .rejects.toThrow('no longer pending');
    await second.decision.respond({ allow: false });
    expect(acp.writes.filter((message) => message.id === 'permission-reused')).toMatchObject([
      { result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
      { result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
    ]);

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('auto-approves standard ACP permission requests in manual bypass without emitting a row', async () => {
    const { acp, runtime } = createRuntimeHarness();
    const published = collectOperation('run-bypass');
    await runtime.startSession(startRequest({
      permissionMode: 'manualBypass',
      operation: published.operation,
    }));
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
    expect(published.events.some((event) => event.type === 'permission')).toBe(false);

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('uses live manual bypass setting updates for subsequent ACP permission requests', async () => {
    const { acp, runtime } = createRuntimeHarness();
    const published = collectOperation('run-updated-bypass');
    const started = await runtime.startSession(startRequest({ operation: published.operation }));
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
    expect(published.events.some((event) => event.type === 'permission')).toBe(false);

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('emits Cursor ask-question requests and forwards answered responses', async () => {
    const { acp, runtime } = createRuntimeHarness();
    const operation = collectOperation('run-1');
    await runtime.startSession(startRequest({ operation: operation.operation }));
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

    const answered = {
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['agent'] }],
      },
    };
    const permission = await operation.waitForEvent((event) => event.type === 'permission');
    expect(permission.lifecycle.requestedTool).toBeInstanceOf(CursorAskQuestionToolUseMessage);
    expect(permission.lifecycle.requestedTool.questions[0].prompt).toBe('Which mode?');
    await permission.decision.respond({ allow: true, response: answered });

    const response = await acp.waitForWrite((message) => message.id === 'question-1' && message.result);
    expect(response.result).toEqual(answered);

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('emits Cursor create-plan requests and can reject them', async () => {
    const { acp, runtime } = createRuntimeHarness();
    const operation = collectOperation('run-1');
    await runtime.startSession(startRequest({ operation: operation.operation }));
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

    const permission = await operation.waitForEvent((event) => event.type === 'permission');
    expect(permission.lifecycle.requestedTool).toBeInstanceOf(CursorCreatePlanToolUseMessage);
    expect(permission.lifecycle.requestedTool.plan).toBe('Do the work');
    await permission.decision.respond({ allow: false });
    const response = await acp.waitForWrite((message) => message.id === 'plan-1' && message.result);
    expect(response.result).toEqual({
      outcome: { outcome: 'rejected', reason: 'User rejected plan' },
    });

    acp.finishPrompt();
    runtime.shutdown();
  });

  it('rejects permissions in noninteractive Cursor single-query mode without hanging', async () => {
    const acp = createAcpHarness();
    const query = runSingleQuery(
      'hello',
      { model: 'gpt-5.5-extra-high', createTransport: acp.createTransport },
      TEST_CURSOR_CONFIG,
    );
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

  it('rejects explicit generic one-shot effort before opening ACP transport', async () => {
    const createTransport = mock(() => {
      throw new Error('transport should not be created');
    });

    await expect(runSingleQuery(
      'hello',
      { thinkingMode: 'max', createTransport },
      TEST_CURSOR_CONFIG,
    )).rejects.toThrow(
      'cursor does not support explicit one-shot effort max',
    );
    expect(createTransport).not.toHaveBeenCalled();
  });
});
