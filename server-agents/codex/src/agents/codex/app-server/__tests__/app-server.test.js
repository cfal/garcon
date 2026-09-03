import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { BashToolUseMessage, CodexSubagentToolUseMessage, ExecToolUseMessage, ToolResultMessage, WaitToolUseMessage, codexSubagentSourceFingerprint } from '@garcon/common/chat-types';
import { getNativeMessageRevisionSource } from '@garcon/server-agent-common/shared/native-message-source';
import { buildApprovalMessage, buildApprovalResponse, createPendingApproval } from '../approvals.ts';
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
} from '../client.ts';
import { convertCodexAppServerItem, convertCodexAppServerLiveItem, convertCodexRawCodeModeItem } from '../converter.ts';
import { waitForMaterializedThread } from '../durability.ts';
import { cleanupOwnedGoalAttachments, materializeGoalDraft } from '../goal-files.ts';
import { CodexAppServerRuntime } from '../runtime.ts';
import { isRetainedSourceInUse } from '../runtime-support.ts';
import { loadCodexChatMessages } from '../../history-loader.ts';
import { ChatExecutionCoordinator } from '../../../../../../../server/chat-execution/chat-execution-coordinator.ts';
import { InMemoryChatExecutionControlRepository } from '../../../../../../../server/chat-execution/chat-execution-control-repository.ts';
import {
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadSettingsUpdateParams,
  buildThreadStartParams,
  buildTurnStartParams,
  codexThreadSettingsTarget,
  mapThinkingModeToCodexEffort,
} from '../request-builders.ts';

function createRuntime(options) {
  return new CodexAppServerRuntime(options);
}

function collectOperation(chatId = 'chat-1', runId = 'run-default') {
  const events = [];
  const waiters = new Set();
  return {
    events,
    operation: Object.freeze({
      chatId,
      runId,
      publish(event) {
        events.push(event);
        for (const waiter of waiters) {
          if (!waiter.predicate(event)) continue;
          waiters.delete(waiter);
          waiter.resolve(event);
        }
      },
    }),
    waitForEvent(predicate) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.add({ predicate, resolve }));
    },
  };
}

function publishedMessages(events) {
  return events.flatMap((event) => (
    event.type === 'rows' ? event.rows.map((row) => row.message) : []
  ));
}

function permissionEvents(events) {
  return events.filter((event) => event.type === 'permission');
}

function terminalEvents(events) {
  return events.filter((event) => event.type === 'run-ended');
}

function failureMessages(events) {
  return terminalEvents(events)
    .filter((event) => event.outcome === 'failed')
    .map((event) => event.error?.message);
}

function makeRequest(overrides = {}) {
  const request = {
    chatId: 'chat-1',
    command: 'hello',
    projectPath: '/repo',
    model: 'gpt-5.4-codex',
    permissionMode: 'default',
    thinkingMode: 'medium',
    ...overrides,
  };
  if (request.operation) return request;
  return {
    ...request,
    operation: collectOperation(request.chatId).operation,
  };
}

function makeThread(overrides = {}) {
  return {
    id: 'thread-1',
    forkedFromId: null,
    preview: 'hello',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    status: { type: 'idle' },
    path: null,
    cwd: '/repo',
    cliVersion: '0.125.0',
    source: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function makeTurn(overrides = {}) {
  return {
    id: 'turn-1',
    items: [],
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
    durationMs: 1000,
    ...overrides,
  };
}

async function waitForMissingPath(targetPath) {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      await fs.access(targetPath);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`Path was not removed: ${targetPath}`);
    await Bun.sleep(5);
  }
}

async function waitForCondition(condition) {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Condition was not met before the deadline');
    await Bun.sleep(5);
  }
}

function usageSession(overrides = {}) {
  return {
    threadId: 'thread-1',
    status: 'completed',
    interruptAcknowledgement: null,
    pendingThreadSettings: null,
    turnStartWaiters: new Set(),
    activeDeliveryReservations: 0,
    managesGoalLifecycle: false,
    activeTurnId: null,
    goal: null,
    ...overrides,
  };
}

function emitCapacityFailure(client, turnId) {
  const error = {
    message: 'Selected model is at capacity. Please try a different model.',
    codexErrorInfo: 'serverOverloaded',
    additionalDetails: null,
  };
  client.emit('notification', {
    method: 'error',
    params: {
      threadId: 'thread-1',
      turnId,
      willRetry: false,
      error,
    },
  });
  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: makeTurn({ id: turnId, status: 'failed', error }),
    },
  });
}

function createControlledDelay() {
  let release;
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  return {
    started,
    wait: (delayMs) => {
      resolveStarted(delayMs);
      return new Promise((resolve) => { release = resolve; });
    },
    release: () => release(),
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function makeGoal(threadId, objective, status = 'active') {
  return {
    threadId,
    objective,
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

async function writeJsonl(filePath, entries) {
  await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function commandHistoryEntries(callId, command, output) {
  return [
    {
      type: 'session_meta',
      timestamp: '2026-07-28T00:00:00.000Z',
      payload: { id: 'thread-1', history_mode: 'legacy' },
    },
    {
      type: 'event_msg',
      timestamp: '2026-07-28T00:00:01.000Z',
      payload: { type: 'user_message', message: 'Run the command' },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-28T00:00:02.000Z',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: command, workdir: '/repo' }),
        call_id: callId,
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-28T00:00:03.000Z',
      payload: { type: 'function_call_output', call_id: callId, output },
    },
  ];
}

class FakeClient extends EventEmitter {
  constructor(script = {}) {
    super();
    this.script = script;
    this.startThread = mock(script.startThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.resumeThread = mock(script.resumeThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.forkThread = mock(script.forkThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.updateThreadSettings = mock(script.updateThreadSettings ?? (async () => ({})));
    this.setThreadGoal = mock(script.setThreadGoal ?? (async (threadId, params) => ({
      goal: makeGoal(threadId, params.objective ?? 'Ship the feature', params.status ?? 'active'),
    })));
    this.setThreadGoalStatus = mock(script.setThreadGoalStatus ?? (async (threadId, status) => ({ goal: makeGoal(threadId, 'Ship the feature', status) })));
    this.getThreadGoal = mock(script.getThreadGoal ?? (async () => ({ goal: null })));
    this.clearThreadGoal = mock(script.clearThreadGoal ?? (async () => ({ cleared: true })));
    this.injectThreadItems = mock(script.injectThreadItems ?? (async () => ({})));
    this.listThreads = mock(script.listThreads ?? (async () => ({ data: [], nextCursor: null, backwardsCursor: null })));
    this.listThreadTurns = mock(script.listThreadTurns ?? (async () => ({ data: [], nextCursor: null, backwardsCursor: null })));
    this.listThreadItems = mock(script.listThreadItems ?? (async () => ({ data: [], nextCursor: null, backwardsCursor: null })));
    this.loadedThreads = mock(script.loadedThreads ?? (async () => ({ data: [] })));
    this.unsubscribeThread = mock(script.unsubscribeThread ?? (async () => ({ status: 'notSubscribed' })));
    this.startTurn = mock(script.startTurn ?? (async () => ({ turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } })));
    this.steerTurn = mock(script.steerTurn ?? (async ({ expectedTurnId }) => ({ turnId: expectedTurnId })));
    this.interruptTurn = mock(script.interruptTurn ?? (async () => ({})));
    this.compactThread = mock(script.compactThread ?? (async () => ({})));
    this.connect = mock(script.connect ?? (async () => ({ userAgent: 'codex', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' })));
    this.respond = mock();
    this.reject = mock();
    this.shutdown = mock(script.shutdown ?? (() => undefined));
  }
}

function createRpcClientFixture(responder, options = {}) {
  const encoder = new TextEncoder();
  let controller;
  let resolveExit;
  const writes = [];
  const stdout = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
    },
  });
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const finishExit = () => {
    try {
      controller.close();
    } catch {
      // The stream may already be closed by the test.
    }
    resolveExit(0);
  };
  const sendResult = (id, result) => {
    controller.enqueue(encoder.encode(`${JSON.stringify({ id, result })}\n`));
  };
  const sendServerRequest = (id, method, params) => {
    controller.enqueue(encoder.encode(`${JSON.stringify({ id, method, params })}\n`));
  };
  const sendNotification = (method, params) => {
    controller.enqueue(encoder.encode(`${JSON.stringify({ method, params })}\n`));
  };
  const proc = {
    stdin: {
      write(data) {
        const line = String(data).trim();
        const message = JSON.parse(line);
        writes.push(message);
        if (typeof message.id !== 'number') return;

        const response = responder(message);
        if (response === undefined && options.allowMissingResponse) return;
        if (response?.error) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ id: message.id, error: response.error })}\n`));
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify({ id: message.id, result: response })}\n`));
      },
      end: mock(() => {
        if (options.exitOnEnd !== false) finishExit();
      }),
    },
    stdout,
    stderr: null,
    exited,
    kill: mock(finishExit),
  };
  const spawn = mock(() => proc);
  const client = new CodexAppServerClient({
    spawn,
    resolveCli: async () => ({ command: '/tmp/codex', source: 'bundled' }),
    shutdownGraceMs: options.shutdownGraceMs,
  });
  return { client, writes, spawn, proc, finishExit, sendResult, sendServerRequest, sendNotification };
}

const initializeResponse = {
  userAgent: 'codex',
  codexHome: '/tmp/codex-home',
  platformFamily: 'unix',
  platformOs: 'linux',
};

describe('CodexAppServerClient lifecycle RPCs', () => {
  it('closes stdin and waits for a clean app-server exit before the fallback kill', async () => {
    const { client, proc, finishExit } = createRpcClientFixture(
      () => initializeResponse,
      { exitOnEnd: false, shutdownGraceMs: 100 },
    );
    await client.connect();

    const shutdown = client.shutdown();
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalled();

    finishExit();
    await shutdown;
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('kills the app-server when graceful shutdown exceeds its bound', async () => {
    const { client, proc } = createRpcClientFixture(
      () => initializeResponse,
      { exitOnEnd: false, shutdownGraceMs: 1 },
    );
    await client.connect();

    await client.shutdown();

    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('keeps reading messages after a notification handler throws', async () => {
    const { client, sendNotification } = createRpcClientFixture(() => initializeResponse);
    const warnings = [];
    const delivered = [];
    client.on('warning', (message) => warnings.push(message));
    client.on('notification', (notification) => {
      delivered.push(notification.method);
      if (notification.method === 'first') throw new Error('handler exploded');
    });
    await client.connect();

    sendNotification('first', { threadId: 'thread-1' });
    sendNotification('second', { threadId: 'thread-1' });
    await waitForCondition(() => delivered.length === 2);

    expect(delivered).toEqual(['first', 'second']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('handler failed');
    await client.shutdown();
  });

  it('requests full paginated turns with the typed app-server contract', async () => {
    const { client, writes } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      if (message.method === 'thread/turns/list') {
        return {
          data: [makeTurn({ id: 'turn-history', items: [{
            type: 'agentMessage', id: 'message-1', text: 'history', phase: null, memoryCitation: null,
          }] })],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected method ${message.method}`);
    });

    await expect(client.listThreadTurns({
      threadId: 'thread-1',
      cursor: null,
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'full',
    })).resolves.toMatchObject({ data: [{ id: 'turn-history', itemsView: 'full' }] });
    await client.shutdown();

    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/turns/list',
      params: {
        threadId: 'thread-1',
        cursor: null,
        limit: 100,
        sortDirection: 'asc',
        itemsView: 'full',
      },
    }));
  });

  it('requests and validates paginated thread items', async () => {
    const { client, writes } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      if (message.method === 'thread/items/list') {
        return {
          data: [{
            turnId: 'turn-history',
            item: {
              type: 'functionCallOutput',
              id: 'result-1',
              name: 'lookup',
              namespace: 'tools',
              output: [{ type: 'input_text', text: 'history result' }],
            },
          }],
          nextCursor: 'next-item-page',
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected method ${message.method}`);
    });

    await expect(client.listThreadItems({
      threadId: 'thread-1',
      cursor: null,
      limit: 100,
      sortDirection: 'asc',
    })).resolves.toEqual({
      data: [{
        turnId: 'turn-history',
        item: {
          type: 'functionCallOutput',
          id: 'result-1',
          name: 'lookup',
          namespace: 'tools',
          output: [{ type: 'input_text', text: 'history result' }],
        },
      }],
      nextCursor: 'next-item-page',
      backwardsCursor: null,
    });
    await client.shutdown();

    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/items/list',
      params: {
        threadId: 'thread-1',
        cursor: null,
        limit: 100,
        sortDirection: 'asc',
      },
    }));
  });

  it('sends a combined thread settings update', async () => {
    const { client, writes } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      if (message.method === 'thread/settings/update') return {};
      throw new Error(`Unexpected method ${message.method}`);
    });

    await client.connect();
    await expect(client.updateThreadSettings({
      threadId: 'thread-1',
      model: 'gpt-5.4-mini',
      effort: 'high',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    })).resolves.toEqual({});
    await client.shutdown();

    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/settings/update',
      params: {
        threadId: 'thread-1',
        model: 'gpt-5.4-mini',
        effort: 'high',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    }));
  });

  it('accepts 0.153 collaboration and error shapes in paginated turns', async () => {
    const { client } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      return {
        data: [makeTurn({
          error: {
            message: 'Blocked by policy',
            codexErrorInfo: 'misalignmentPolicyViolation',
            additionalDetails: null,
            misalignment: {
              errorType: 'policy_mismatch',
              detailedExplanation: 'The request conflicts with policy.',
              steer: { message: 'Continue without the restricted action.' },
            },
          },
          items: [
            {
              type: 'collabAgentToolCall',
              id: 'collab-1',
              tool: 'followupTask',
              status: 'interrupted',
              senderThreadId: 'thread-1',
              receiverThreadIds: ['thread-2'],
              prompt: 'Continue review',
              model: null,
              reasoningEffort: null,
              agentsStates: {},
            },
            {
              type: 'subAgentActivity',
              id: 'activity-1',
              kind: 'completed',
              agentThreadId: 'thread-2',
              agentPath: '/root/reviewer',
            },
          ],
        })],
        nextCursor: null,
        backwardsCursor: null,
      };
    });

    await expect(client.listThreadTurns({
      threadId: 'thread-1',
      sortDirection: 'asc',
      itemsView: 'full',
    })).resolves.toMatchObject({
      data: [{
        error: { codexErrorInfo: 'misalignmentPolicyViolation' },
        items: [
          { tool: 'followupTask', status: 'interrupted' },
          { kind: 'completed' },
        ],
      }],
    });
    await client.shutdown();
  });

  it('preserves string JSON-RPC ids on server requests and responses', async () => {
    const fixture = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      throw new Error(`Unexpected method ${message.method}`);
    });
    const request = new Promise((resolve) => fixture.client.once('serverRequest', resolve));
    await fixture.client.connect();

    fixture.sendServerRequest('approval-request-1', 'item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      startedAtMs: 1_700_000_000_000,
    });

    await expect(request).resolves.toMatchObject({ id: 'approval-request-1' });
    fixture.client.respond('approval-request-1', { decision: 'accept' });
    expect(fixture.writes).toContainEqual({
      id: 'approval-request-1',
      result: { decision: 'accept' },
    });
    await fixture.client.shutdown();
  });

    it('rejects unknown paginated public item discriminators', async () => {
    const { client } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      return {
        data: [makeTurn({ items: [{ type: 'futureItem', id: 'item-1' }] })],
        nextCursor: null,
        backwardsCursor: null,
      };
    });

    await expect(client.listThreadTurns({
      threadId: 'thread-1',
      sortDirection: 'asc',
      itemsView: 'full',
    })).rejects.toThrow('Unsupported Codex thread item type: futureItem');
      await client.shutdown();
    });

    it('accepts canonical sleep items and validates their duration', async () => {
      const valid = createRpcClientFixture((message) => {
        if (message.method === 'initialize') return initializeResponse;
        return {
          data: [makeTurn({ items: [{ type: 'sleep', id: 'sleep-1', durationMs: 250 }] })],
          nextCursor: null,
          backwardsCursor: null,
        };
      });
      await expect(valid.client.listThreadTurns({
        threadId: 'thread-1',
        sortDirection: 'asc',
        itemsView: 'full',
      })).resolves.toMatchObject({ data: [{ items: [{ type: 'sleep', durationMs: 250 }] }] });
      await valid.client.shutdown();

      const invalid = createRpcClientFixture((message) => {
        if (message.method === 'initialize') return initializeResponse;
        return {
          data: [makeTurn({ items: [{ type: 'sleep', id: 'sleep-1', durationMs: -1 }] })],
          nextCursor: null,
          backwardsCursor: null,
        };
      });
      await expect(invalid.client.listThreadTurns({
        threadId: 'thread-1',
        sortDirection: 'asc',
        itemsView: 'full',
      })).rejects.toThrow('durationMs');
      await invalid.client.shutdown();
    });

  it('sends loaded-list and unsubscribe requests with metrics', async () => {
    const { client, writes, spawn } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      if (message.method === 'thread/loaded/list') return { data: ['thread-1'] };
      if (message.method === 'thread/unsubscribe') return { status: 'notSubscribed' };
      throw new Error(`Unexpected method ${message.method}`);
    });
    const metrics = [];
    client.on('metric', (metric) => metrics.push(metric));

    await expect(client.loadedThreads()).resolves.toEqual({ data: ['thread-1'] });
    await expect(client.unsubscribeThread('thread-1')).resolves.toEqual({ status: 'notSubscribed' });
    await client.shutdown();

    expect(spawn).toHaveBeenCalledWith('/tmp/codex', ['app-server', '--listen', 'stdio://'], expect.any(Object));
    expect(writes).toContainEqual(expect.objectContaining({ method: 'thread/loaded/list', params: {} }));
    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/unsubscribe',
      params: { threadId: 'thread-1' },
    }));
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'codex.app_server.startup', commandSource: 'bundled' }),
      expect.objectContaining({ name: 'codex.app_server.request', method: 'thread/loaded/list', success: true }),
      expect.objectContaining({ name: 'codex.app_server.request', method: 'thread/unsubscribe', success: true }),
    ]));
  });

  it('manages native app-server goals on a thread', async () => {
    const { client, writes } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      if (message.method === 'thread/goal/set') {
        return { goal: makeGoal(message.params.threadId, message.params.objective ?? 'Ship the feature', message.params.status) };
      }
      if (message.method === 'thread/goal/get') return { goal: makeGoal(message.params.threadId, 'Ship the feature') };
      if (message.method === 'thread/goal/clear') return { cleared: true };
      if (message.method === 'thread/inject_items') return {};
      if (message.method === 'turn/steer') return { turnId: message.params.expectedTurnId };
      throw new Error(`Unexpected method ${message.method}`);
    });

    await expect(client.setThreadGoal('thread-1', { objective: 'Ship the feature', status: 'active' })).resolves.toMatchObject({
      goal: {
        threadId: 'thread-1',
        objective: 'Ship the feature',
        status: 'active',
      },
    });
    await expect(client.setThreadGoalStatus('thread-1', 'paused')).resolves.toMatchObject({
      goal: { threadId: 'thread-1', status: 'paused' },
    });
    await expect(client.getThreadGoal('thread-1')).resolves.toMatchObject({
      goal: { threadId: 'thread-1', objective: 'Ship the feature' },
    });
    await expect(client.clearThreadGoal('thread-1')).resolves.toEqual({ cleared: true });
    await expect(client.injectThreadItems({
      threadId: 'thread-1',
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier context' }] }],
    })).resolves.toEqual({});
    await expect(client.steerTurn({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'message-1',
      input: [{ type: 'text', text: 'Steer now' }],
    })).resolves.toEqual({ turnId: 'turn-1' });
    await client.shutdown();

    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/goal/set',
      params: {
        threadId: 'thread-1',
        objective: 'Ship the feature',
        status: 'active',
      },
    }));
    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/goal/set',
      params: {
        threadId: 'thread-1',
        status: 'paused',
      },
    }));
    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/goal/get',
      params: { threadId: 'thread-1' },
    }));
    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/goal/clear',
      params: { threadId: 'thread-1' },
    }));
    expect(writes).toContainEqual(expect.objectContaining({
      method: 'thread/inject_items',
      params: {
        threadId: 'thread-1',
        items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier context' }] }],
      },
    }));
    expect(writes).toContainEqual(expect.objectContaining({
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'message-1',
        input: [{ type: 'text', text: 'Steer now' }],
      },
    }));
  });

  it('prepares strict steering immediately before the native write', async () => {
    const events = [];
    const { client, writes } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      events.push('written');
      return { turnId: message.params.expectedTurnId };
    });

    await expect(client.steerTurn({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'message-1',
      input: [{ type: 'text', text: 'focus here' }],
    }, {
      prepareDelivery: async () => { events.push('prepared'); },
      acknowledgementTimeoutMs: 100,
    })).resolves.toEqual({ turnId: 'turn-1' });

    expect(events).toEqual(['prepared', 'written']);
    expect(writes.at(-1)).toMatchObject({
      method: 'turn/steer',
      params: {
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'message-1',
      },
    });
    await client.shutdown();
  });

  it('classifies strict steering serialization failure as definitely not sent', async () => {
    const { client } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      throw new Error(`Unexpected method ${message.method}`);
    });
    await client.connect();
    const circular = {};
    circular.self = circular;
    const prepareDelivery = mock(async () => undefined);

    await expect(client.steerTurn({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [circular],
    }, { prepareDelivery })).rejects.toMatchObject({
      outcome: 'not-sent',
      name: 'CodexAppServerDeliveryError',
    });
    expect(prepareDelivery).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('classifies a strict steering write failure as outcome unknown', async () => {
    const { client, proc } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      throw new Error(`Unexpected method ${message.method}`);
    });
    await client.connect();
    proc.stdin.write = mock(() => {
      throw new Error('pipe write failed');
    });

    await expect(client.steerTurn({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'focus here' }],
    }, {
      prepareDelivery: async () => undefined,
      acknowledgementTimeoutMs: 100,
    })).rejects.toMatchObject({
      outcome: 'unknown',
      name: 'CodexAppServerDeliveryError',
    });
    await client.shutdown();
  });

  it('classifies app-server exit after a strict steering write as outcome unknown', async () => {
    const { client, writes, finishExit } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      return undefined;
    }, { allowMissingResponse: true });
    await client.connect();

    const steering = client.steerTurn({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'focus here' }],
    }, {
      prepareDelivery: async () => undefined,
      acknowledgementTimeoutMs: 100,
    });
    while (!writes.some((write) => write.method === 'turn/steer')) await Bun.sleep(0);
    finishExit();

    await expect(steering).rejects.toMatchObject({
      outcome: 'unknown',
      name: 'CodexAppServerDeliveryError',
    });
    await client.shutdown();
  });

  it('bounds strict steering acknowledgement and ignores its late response', async () => {
    const { client, writes, sendResult } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      return undefined;
    }, { allowMissingResponse: true });
    const warnings = [];
    client.on('warning', (warning) => warnings.push(warning));

    await expect(client.steerTurn({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'focus here' }],
    }, {
      prepareDelivery: async () => undefined,
      acknowledgementTimeoutMs: 5,
    })).rejects.toMatchObject({
      outcome: 'unknown',
      name: 'CodexAppServerDeliveryError',
    });

    const request = writes.find((write) => write.method === 'turn/steer');
    sendResult(request.id, { turnId: 'turn-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings).toContain(`Ignoring late Codex app-server response: ${request.id}`);
    await client.shutdown();
  });

  it('emits a failed request metric when the app-server rejects a request', async () => {
    const { client } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      return { error: { code: -32001, message: 'Server overloaded' } };
    });
    const metrics = [];
    client.on('metric', (metric) => metrics.push(metric));

    await expect(client.loadedThreads()).rejects.toThrow('Server overloaded');
    await client.shutdown();

    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'codex.app_server.request', method: 'thread/loaded/list', success: false }),
    ]));
  });
});

describe('Codex app-server request builders', () => {
  it('builds durable thread/start params with sandbox and config', () => {
    const params = buildThreadStartParams(makeRequest({
      permissionMode: 'bypassPermissions',
      codexConfig: { config: { model_provider: 'openai' } },
    }));

    expect(params).toMatchObject({
      model: 'gpt-5.4-codex',
      cwd: '/repo',
      historyMode: 'paginated',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      config: { model_provider: 'openai' },
    });
    expect(params).not.toHaveProperty('experimentalRawEvents');
    expect(params).not.toHaveProperty('persistExtendedHistory');
  });

  it('keeps manual bypass sandboxed while enabling Codex approval requests', () => {
    const startParams = buildThreadStartParams(makeRequest({ permissionMode: 'manualBypass' }));
    const turnParams = buildTurnStartParams({
      threadId: 'thread-1',
      command: 'run this',
      model: 'gpt-5.4-codex',
      projectPath: '/repo',
      permissionMode: 'manualBypass',
      thinkingMode: 'none',
    });

    expect(startParams).toMatchObject({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    expect(turnParams).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    expect(turnParams).not.toHaveProperty('effort');
  });

  it('maps Garcon thinking modes to Codex effort overrides', () => {
    expect(mapThinkingModeToCodexEffort(undefined)).toBeUndefined();
    expect(mapThinkingModeToCodexEffort('none')).toBeUndefined();
    expect(mapThinkingModeToCodexEffort('low')).toBe('low');
    expect(mapThinkingModeToCodexEffort('medium')).toBe('medium');
    expect(mapThinkingModeToCodexEffort('high')).toBe('high');
    expect(mapThinkingModeToCodexEffort('xhigh')).toBe('xhigh');
    expect(mapThinkingModeToCodexEffort('max', 'gpt-5.5')).toBe('xhigh');
    for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(mapThinkingModeToCodexEffort('max', model)).toBe('max');
    }
    expect(mapThinkingModeToCodexEffort('ultra')).toBe('ultra');
  });

  it('builds one complete subsequent-turn settings update', () => {
    const target = codexThreadSettingsTarget({
      model: 'gpt-5.4-mini',
      permissionMode: 'manualBypass',
      thinkingMode: 'high',
    });

    expect(buildThreadSettingsUpdateParams('thread-1', target)).toEqual({
      threadId: 'thread-1',
      model: 'gpt-5.4-mini',
      effort: 'high',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    expect(buildThreadSettingsUpdateParams('thread-1', codexThreadSettingsTarget({
      model: 'gpt-5.4-mini',
      permissionMode: 'bypassPermissions',
      thinkingMode: 'none',
    }))).toEqual({
      threadId: 'thread-1',
      model: 'gpt-5.4-mini',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('uses max effort for GPT-5.6 turn params', () => {
    const params = buildTurnStartParams({
      threadId: 'thread-1',
      command: 'hello',
      model: 'gpt-5.6-luna',
      projectPath: '/repo',
      permissionMode: 'default',
      thinkingMode: 'max',
    });

    expect(params.effort).toBe('max');
  });

  it('keeps max compatible with models that only support xhigh', () => {
    const params = buildTurnStartParams({
      threadId: 'thread-1',
      command: 'hello',
      model: 'gpt-5.5',
      projectPath: '/repo',
      permissionMode: 'default',
      thinkingMode: 'max',
    });

    expect(params.effort).toBe('xhigh');
  });

  it('builds thread/resume params with the rollout path when available', () => {
    const params = buildThreadResumeParams({
      ...makeRequest(),
      agentSessionId: 'thread-1',
      nativePath: '/tmp/jsonl.jsonl',
    });

    expect(params).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-5.4-codex',
      cwd: '/repo',
      excludeTurns: true,
      path: '/tmp/jsonl.jsonl',
    });
    expect(params).not.toHaveProperty('persistExtendedHistory');
  });

  it('builds thread/fork params from durable thread identity and path', () => {
    const params = buildThreadForkParams({
      agentSessionId: 'thread-1',
      nativePath: '/tmp/jsonl.jsonl',
      model: 'gpt-5.4-codex',
      projectPath: '/repo',
    });

    expect(params).toEqual({
      threadId: 'thread-1',
      cwd: '/repo',
      model: 'gpt-5.4-codex',
      ephemeral: false,
      excludeTurns: true,
      path: '/tmp/jsonl.jsonl',
    });
  });

  it('includes Codex config in thread/fork params', () => {
    const params = buildThreadForkParams({
      agentSessionId: 'thread-1',
      model: 'gpt-5.4-codex',
      projectPath: '/repo',
      codexConfig: { config: { model_provider: 'custom-openai' } },
    });

    expect(params).toMatchObject({
      threadId: 'thread-1',
      config: { model_provider: 'custom-openai' },
    });
  });

  it('builds turn/start input and thinking effort', () => {
    const params = buildTurnStartParams({
      threadId: 'thread-1',
      command: 'run this',
      imagePaths: ['/tmp/a.png'],
      model: 'gpt-5.4-codex',
      projectPath: '/repo',
      permissionMode: 'default',
      thinkingMode: 'high',
    });

    expect(params.input).toEqual([
      { type: 'text', text: 'run this', text_elements: [] },
      { type: 'localImage', path: '/tmp/a.png' },
    ]);
    expect(params.effort).toBe('high');
  });

  it('omits turn/start effort for provider default thinking', () => {
    const params = buildTurnStartParams({
      threadId: 'thread-1',
      command: 'run this',
      model: 'gpt-5.4-codex',
      projectPath: '/repo',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    expect(params).not.toHaveProperty('effort');
  });

  it('adds non-image attachment paths to Codex text input', () => {
    const params = buildTurnStartParams({
      threadId: 'thread-1',
      command: 'read this',
      filePaths: ['/tmp/guide.md', '/tmp/spec.pdf'],
      model: 'gpt-5.4-codex',
      projectPath: '/repo',
      permissionMode: 'default',
    });

    expect(params.input).toEqual([
      {
        type: 'text',
        text: 'read this\n\nAttached files are available on disk:\n\n- /tmp/guide.md\n- /tmp/spec.pdf',
        text_elements: [],
      },
    ]);
  });
});

describe('Codex app-server durability', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-server-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns the app-server native path once it exists', async () => {
    const filePath = path.join(tmpDir, 'thread.jsonl');
    await fs.writeFile(filePath, '{}\n');

    await expect(waitForMaterializedThread({ id: 'thread-1', path: filePath }, { timeoutMs: 10 })).resolves.toBe(filePath);
  });

  it('rejects threads without a native path', async () => {
    await expect(waitForMaterializedThread({ id: 'thread-1', path: null }, { timeoutMs: 10 })).rejects.toThrow('did not report');
  });
});

describe('Codex app-server converter', () => {
  it('normalizes only tracked raw Exec calls and outputs', () => {
    const activeCodeModeResultToolIds = new Map();
    const code = '// @exec: {"yield_time_ms": 1000}\ntext("ok")';

    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'other',
      call_id: 'call-other',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeCodeModeResultToolIds)).toEqual([]);
    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-other',
      output: 'ignored',
    }, '2026-07-10T21:34:09.149Z', activeCodeModeResultToolIds)).toEqual([]);

    const input = convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeCodeModeResultToolIds);
    expect(input).toHaveLength(1);
    expect(input[0]).toBeInstanceOf(ExecToolUseMessage);
    expect(input[0]).toMatchObject({
      toolId: 'call-exec',
      code,
      language: 'javascript',
    });
    expect(activeCodeModeResultToolIds.get('call-exec')).toBe('call-exec');

    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeCodeModeResultToolIds)).toEqual([]);

    const output = convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec',
      output: [{ type: 'input_text', text: 'ok' }],
    }, '2026-07-10T21:34:09.150Z', activeCodeModeResultToolIds);
    expect(output).toHaveLength(1);
    expect(output[0]).toBeInstanceOf(ToolResultMessage);
    expect(output[0]).toMatchObject({
      toolId: 'call-exec',
      content: { items: [{ type: 'input_text', text: 'ok' }] },
      isError: false,
    });
    expect(activeCodeModeResultToolIds.has('call-exec')).toBe(false);
    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec',
      output: 'duplicate',
    }, '2026-07-10T21:34:09.151Z', activeCodeModeResultToolIds)).toEqual([]);

    convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec-string',
      input: 'text("done")',
    }, '2026-07-10T21:34:09.152Z', activeCodeModeResultToolIds);
    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec-string',
      output: 'Script completed',
    }, '2026-07-10T21:34:09.153Z', activeCodeModeResultToolIds)[0]).toMatchObject({
      content: { raw: 'Script completed' },
    });
  });

  it('projects shell-only raw Exec calls and associates output with the final command', () => {
    const activeCodeModeResultToolIds = new Map();
    const code = `
      const results = await Promise.all([
        tools.exec_command({cmd: "git status"}),
        tools.exec_command({cmd: "git diff --stat"}),
      ]);
      results.forEach(result => text(result.output));
    `;

    const input = convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-bash',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeCodeModeResultToolIds);

    expect(input).toHaveLength(2);
    expect(input.every((message) => message instanceof BashToolUseMessage)).toBe(true);
    expect(input).toMatchObject([
      { toolId: 'codex-code-mode:call-bash:0', command: 'git status' },
      { toolId: 'codex-code-mode:call-bash:1', command: 'git diff --stat' },
    ]);
    expect(activeCodeModeResultToolIds.get('call-bash')).toBe('codex-code-mode:call-bash:1');

    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-bash',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeCodeModeResultToolIds)).toEqual([]);

    const output = convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-bash',
      output: 'aggregate output',
    }, '2026-07-10T21:34:09.150Z', activeCodeModeResultToolIds);

    expect(output).toMatchObject([{
      type: 'tool-result',
      toolId: 'codex-code-mode:call-bash:1',
      content: { raw: 'aggregate output' },
    }]);
    expect(activeCodeModeResultToolIds.size).toBe(0);
  });

  it('ignores malformed raw Exec calls', () => {
    const activeCodeModeResultToolIds = new Map();
    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
    }, '2026-07-10T21:34:09.149Z', activeCodeModeResultToolIds)).toEqual([]);
    expect(activeCodeModeResultToolIds.size).toBe(0);
  });

  it('normalizes only tracked raw Wait calls and outputs', () => {
    const activeCodeModeResultToolIds = new Map();
    const input = convertCodexRawCodeModeItem({
      type: 'function_call',
      name: 'wait',
      call_id: 'call-wait',
      arguments: '{"cell_id":"46","yield_time_ms":30000,"max_tokens":12000}',
    }, '2026-07-11T00:27:03.417Z', activeCodeModeResultToolIds);

    expect(input).toHaveLength(1);
    expect(input[0]).toBeInstanceOf(WaitToolUseMessage);
    expect(input[0]).toMatchObject({
      toolId: 'call-wait',
      executionId: '46',
      yieldTimeMs: 30000,
      maxTokens: 12000,
    });
    expect(activeCodeModeResultToolIds.get('call-wait')).toBe('call-wait');

    const output = convertCodexRawCodeModeItem({
      type: 'function_call_output',
      call_id: 'call-wait',
      output: 'Script completed',
    }, '2026-07-11T00:27:33.417Z', activeCodeModeResultToolIds);

    expect(output[0]).toBeInstanceOf(ToolResultMessage);
    expect(output[0]).toMatchObject({
      toolId: 'call-wait',
      content: { raw: 'Script completed' },
      isError: false,
    });
    expect(activeCodeModeResultToolIds.has('call-wait')).toBe(false);
  });

  it('ignores malformed raw Wait calls', () => {
    const activeCodeModeResultToolIds = new Map();
    expect(convertCodexRawCodeModeItem({
      type: 'function_call',
      name: 'wait',
      call_id: 'call-wait',
      arguments: '{"yield_time_ms":30000}',
    }, '2026-07-11T00:27:03.417Z', activeCodeModeResultToolIds)).toEqual([]);
    expect(activeCodeModeResultToolIds.size).toBe(0);
  });

  it('converts app-server live item families to shared chat messages', () => {
    const items = [
      {
        type: 'userMessage',
        id: 'u1',
        clientId: 'message-1',
        content: [{ type: 'text', text: 'Hi', text_elements: [] }],
      },
      { type: 'reasoning', id: 'r1', summary: ['thinking'], content: [] },
      { type: 'agentMessage', id: 'a1', text: 'Hello', phase: null, memoryCitation: null },
      { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/repo', processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: 'ok', exitCode: 0, durationMs: 12 },
      { type: 'fileChange', id: 'f1', changes: [{ path: '/repo/a.txt', kind: 'update' }], status: 'completed' },
      { type: 'webSearch', id: 'w1', query: 'codex app server', action: null },
    ];

    const messages = items.flatMap((item) => convertCodexAppServerItem(item, '2026-02-21T10:00:00.000Z'));

    expect(messages.map((message) => message.type)).toEqual([
      'user-message',
      'thinking',
      'assistant-message',
      'bash-tool-use',
      'tool-result',
      'edit-tool-use',
      'tool-result',
      'web-search-tool-use',
      'tool-result',
    ]);
    expect(messages[0]).toMatchObject({
      metadata: { upstreamRequestId: 'message-1' },
    });
    expect(messages.find((message) => message.type === 'web-search-tool-use')?.query).toBe('codex app server');
  });

  it('normalizes Codex shell wrappers for loaded and live command executions', () => {
    const item = {
      type: 'commandExecution',
      id: 'command-1',
      command: "/bin/zsh -lc 'git status --short'",
      cwd: '/repo',
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };

    expect(convertCodexAppServerItem(item, '2026-02-21T10:00:00.000Z')[0]).toMatchObject({
      type: 'bash-tool-use',
      command: 'git status --short',
    });
    expect(convertCodexAppServerLiveItem(item, '2026-02-21T10:00:00.000Z')[0]).toMatchObject({
      type: 'bash-tool-use',
      command: 'git status --short',
    });
  });

  it('suppresses echoed user messages on the live notification path', () => {
    expect(convertCodexAppServerLiveItem({
      type: 'userMessage',
      id: 'u1',
      content: [{ type: 'text', text: 'Hi', text_elements: [] }],
    })).toEqual([]);
  });

  it('converts a contextCompaction item to a compaction message', () => {
    const messages = convertCodexAppServerLiveItem({ type: 'contextCompaction', id: 'cc1' });
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('compaction');
    expect(messages[0].trigger).toBe('manual');
    // The app-server exposes no summary or token detail for compaction.
    expect(messages[0].summary).toBe('');
    expect(messages[0].preTokens).toBeUndefined();
  });

  it('labels a contextCompaction item with the trigger supplied by the runtime', () => {
    const auto = convertCodexAppServerLiveItem({ type: 'contextCompaction', id: 'cc1' }, undefined, 'auto');
    expect(auto[0].trigger).toBe('auto');
    const manual = convertCodexAppServerLiveItem({ type: 'contextCompaction', id: 'cc2' }, undefined, 'manual');
    expect(manual[0].trigger).toBe('manual');
  });

  it('uses web-search action details when the app-server top-level query is empty', () => {
    const messages = convertCodexAppServerLiveItem({
      type: 'webSearch',
      id: 'w1',
      query: '',
      action: {
        type: 'search',
        query: 'Kalshi prediction market volume',
        queries: ['ignored fallback'],
      },
    }, '2026-02-21T10:00:00.000Z');

    expect(messages.map((message) => message.type)).toEqual([
      'web-search-tool-use',
      'tool-result',
    ]);
    expect(messages[0].query).toBe('Kalshi prediction market volume');
  });

  it('falls back to web-search action queries and page details without rendering blank searches', () => {
    const items = [
      {
        type: 'webSearch',
        id: 'w1',
        query: '',
        action: { type: 'search', query: null, queries: ['first query', 'second query'] },
      },
      {
        type: 'webSearch',
        id: 'w2',
        query: '',
        action: { type: 'openPage', url: 'https://example.com/page' },
      },
      {
        type: 'webSearch',
        id: 'w3',
        query: '',
        action: { type: 'findInPage', url: 'https://example.com/page', pattern: 'pricing' },
      },
      {
        type: 'webSearch',
        id: 'w4',
        query: '',
        action: null,
      },
    ];

    const searches = items
      .flatMap((item) => convertCodexAppServerLiveItem(item, '2026-02-21T10:00:00.000Z'))
      .filter((message) => message.type === 'web-search-tool-use');

    expect(searches.map((message) => message.query)).toEqual([
      'first query',
      'https://example.com/page',
      'pricing',
    ]);
  });

  it('ignores incomplete web-search rows instead of rendering empty tool calls', () => {
    const messages = [
      {
        type: 'webSearch',
        id: 'w1',
        action: null,
      },
      {
        type: 'webSearch',
        id: 'w2',
        query: '',
        action: { type: 'search', query: null, queries: [null, ''] },
      },
    ].flatMap((item) => convertCodexAppServerLiveItem(item, '2026-02-21T10:00:00.000Z'));

    expect(messages).toEqual([]);
  });

  it('uses generic structured tool-use messages for dynamic and MCP item families', () => {
    const items = [
      { type: 'dynamicToolCall', id: 'd1', namespace: 'app', tool: 'custom_lookup', arguments: { q: 'test' }, status: 'completed', contentItems: [], success: true, durationMs: 10 },
      { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'list_prs', status: 'completed', arguments: { state: 'open' }, result: { content: [] }, error: null, durationMs: 10 },
    ];

    const messages = items.flatMap((item) => convertCodexAppServerItem(item, '2026-02-21T10:00:00.000Z'));

    expect(messages.map((message) => message.type)).toEqual([
      'external-tool-use',
      'tool-result',
      'mcp-tool-use',
      'tool-result',
    ]);
  });

  it('maps function call output items to one standalone result', () => {
    const messages = convertCodexAppServerItem({
      type: 'functionCallOutput',
      id: 'function-result-1',
      name: 'lookup',
      namespace: 'tools',
      output: [{ type: 'input_text', text: 'result text' }],
    }, '2026-02-21T10:00:00.000Z');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(ToolResultMessage);
    expect(messages[0]).toMatchObject({
      toolId: 'function-result-1',
      content: { items: [{ type: 'input_text', text: 'result text' }] },
      isError: false,
    });
  });

  it('maps all 0.153 collaboration tools and interrupted results', () => {
    const expectedActions = {
      sendMessage: 'send_message',
      followupTask: 'followup_task',
      interruptAgent: 'interrupt_agent',
      listAgents: 'list_agents',
    };

    for (const [tool, action] of Object.entries(expectedActions)) {
      const messages = convertCodexAppServerItem({
        type: 'collabAgentToolCall',
        id: `collab-${tool}`,
        tool,
        status: 'interrupted',
        senderThreadId: 'root-thread',
        receiverThreadIds: [],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      }, '2026-02-21T10:00:00.000Z');

      expect(messages[0]).toMatchObject({ action });
      expect(messages[1]).toMatchObject({ type: 'tool-result', isError: false });
    }
  });

  it('maps completed subagent activity to completed status', () => {
    const messages = convertCodexAppServerItem({
      type: 'subAgentActivity',
      id: 'activity-completed-1',
      kind: 'completed',
      agentThreadId: 'worker-thread-1',
      agentPath: '/root/reviewer',
    }, '2026-02-21T10:00:00.000Z');

    expect(messages[0]).toMatchObject({
      action: 'agent_status',
      details: {
        target: '/root/reviewer',
        threadId: 'worker-thread-1',
        agentStates: { '/root/reviewer': { status: 'completed' } },
      },
    });
  });

  it('maps Codex subagent dynamic tool calls to explicit tool-use messages', () => {
    const items = [
      { type: 'dynamicToolCall', id: 'd-sub-1', namespace: null, tool: 'spawn_agent', arguments: { task_name: 'review-auth', message: 'Review auth boundaries', model: 'gpt-5.5' }, status: 'completed', contentItems: [{ type: 'text', text: 'spawned /root/review-auth' }], success: true, durationMs: 10 },
      { type: 'dynamicToolCall', id: 'd-sub-2', namespace: null, tool: 'multi_agent_v1.send_input', arguments: { target: '/root/review-auth', items: [{ type: 'text', text: 'Please inspect converter.ts' }] }, status: 'completed', contentItems: [], success: true, durationMs: 10 },
    ];

    const messages = items.flatMap((item) => convertCodexAppServerItem(item, '2026-02-21T10:00:00.000Z'));

    expect(messages.map((message) => message.type)).toEqual([
      'codex-subagent-tool-use',
      'tool-result',
      'codex-subagent-tool-use',
      'tool-result',
    ]);
    expect(messages[0]).toBeInstanceOf(CodexSubagentToolUseMessage);
    expect(messages[0].action).toBe('spawn_agent');
    expect(messages[0].details).toEqual({
      message: 'Review auth boundaries',
      taskName: 'review-auth',
      model: 'gpt-5.5',
    });
    expect(messages[2]).toBeInstanceOf(CodexSubagentToolUseMessage);
    expect(messages[2].action).toBe('send_input');
    expect(messages[2].details).toEqual({
      target: '/root/review-auth',
      items: [{ type: 'text', text: 'Please inspect converter.ts' }],
    });
  });

  it('maps typed Codex subagent lifecycle items with per-agent states', () => {
    const messages = convertCodexAppServerItem({
      type: 'collabAgentToolCall',
      id: 'collab-wait-1',
      tool: 'wait',
      status: 'failed',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['worker-complete', 'worker-missing'],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {
        'worker-complete': { status: 'completed', message: 'Review complete' },
        'worker-missing': { status: 'notFound', message: null },
      },
    }, '2026-02-21T10:00:00.000Z');

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(CodexSubagentToolUseMessage);
    expect(messages[0]).toMatchObject({
      action: 'wait_agent',
      details: {
        targets: ['worker-complete', 'worker-missing'],
        agentStates: {
          'worker-complete': { status: 'completed', message: 'Review complete' },
          'worker-missing': { status: 'notFound' },
        },
      },
    });
    expect(messages[1]).toBeInstanceOf(ToolResultMessage);
    expect(messages[1].isError).toBe(true);
  });

  it('maps completed typed spawn items during live conversion', () => {
    const messages = convertCodexAppServerLiveItem({
      type: 'collabAgentToolCall',
      id: 'collab-spawn-1',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['worker-running'],
      prompt: 'Review lifecycle handling',
      model: 'gpt-5.6-codex',
      reasoningEffort: 'high',
      agentsStates: {
        'worker-running': { status: 'running', message: null },
      },
    }, '2026-02-21T10:00:00.000Z');

    expect(messages[0]).toMatchObject({
      type: 'codex-subagent-tool-use',
      action: 'spawn_agent',
      details: {
        target: 'worker-running',
        message: 'Review lifecycle handling',
        model: 'gpt-5.6-codex',
        reasoningEffort: 'high',
        agentStates: { 'worker-running': { status: 'running' } },
      },
    });
    expect(messages[1]).toMatchObject({ type: 'tool-result', isError: false });
  });

  it('maps subagent activity and exact v2 terminal response items', () => {
    const envelope = 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\nReview complete';
    const activity = convertCodexAppServerLiveItem({
      type: 'subAgentActivity',
      id: 'activity-worker-1',
      kind: 'started',
      agentThreadId: 'worker-thread-1',
      agentPath: '/root/reviewer',
    }, '2026-02-21T10:00:00.000Z');
    const completion = convertCodexRawCodeModeItem({
      type: 'agent_message',
      id: 'completion-worker-1',
      author: '/root/reviewer',
      recipient: '/root',
      content: [{
        type: 'input_text',
        text: envelope,
      }],
    }, '2026-02-21T10:01:00.000Z', new Map());

    expect(activity[0]).toMatchObject({
      action: 'agent_status',
      details: {
        target: '/root/reviewer',
        threadId: 'worker-thread-1',
        agentStates: { '/root/reviewer': { status: 'running' } },
      },
    });
    expect(completion).toHaveLength(1);
    expect(completion[0]).toMatchObject({
      type: 'codex-subagent-tool-use',
      action: 'agent_status',
      details: {
        target: '/root/reviewer',
        agentStates: { '/root/reviewer': { status: 'completed', message: 'Review complete' } },
        lifecycleSource: 'structured',
        sourceFingerprint: codexSubagentSourceFingerprint(envelope),
      },
    });
  });

  it('maps the canonical live v2 agent error envelope as errored', () => {
    const message = "Agent errored: process exited\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.";
    const completion = convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/reviewer',
      recipient: '/root',
      content: [{
        type: 'input_text',
        text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\n${message}`,
      }],
    }, '2026-02-21T10:01:00.000Z', new Map());

    expect(completion[0]).toMatchObject({
      action: 'agent_status',
      details: {
        target: '/root/reviewer',
        agentStates: { '/root/reviewer': { status: 'errored', message } },
      },
    });
  });

  it('maps a noncanonical live error prefix as completed prose', () => {
    const message = 'Agent errored: initially, but recovered and completed the task.';
    const completion = convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/reviewer',
      recipient: '/root',
      content: [{
        type: 'input_text',
        text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\n${message}`,
      }],
    }, '2026-02-21T10:01:00.000Z', new Map());

    expect(completion[0]).toMatchObject({
      action: 'agent_status',
      details: {
        target: '/root/reviewer',
        agentStates: { '/root/reviewer': { status: 'completed', message } },
      },
    });
  });

  it('rejects v2 terminal response items with invalid or mismatched routing', () => {
    const content = [{
      type: 'input_text',
      text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\nDone',
    }];

    expect(convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/other',
      recipient: '/root',
      content,
    }, '2026-02-21T10:01:00.000Z', new Map())).toEqual([]);
    expect(convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/reviewer',
      recipient: 'root',
      content,
    }, '2026-02-21T10:01:00.000Z', new Map())).toEqual([]);
    expect(convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/reviewer',
      recipient: '/root/other',
      content,
    }, '2026-02-21T10:01:00.000Z', new Map())).toEqual([]);

    const nestedContent = [{
      type: 'input_text',
      text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/parent/child\nPayload:\nDone',
    }];
    expect(convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/parent/child',
      recipient: '/root',
      content: nestedContent,
    }, '2026-02-21T10:01:00.000Z', new Map())).toEqual([]);
  });

  it('maps nested v2 terminal response items to their immediate parent', () => {
    const completion = convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/parent/child',
      recipient: '/root/parent',
      content: [{
        type: 'input_text',
        text: 'Message Type: FINAL_ANSWER\nTask name: /root/parent\nSender: /root/parent/child\nPayload:\nDone',
      }],
    }, '2026-02-21T10:01:00.000Z', new Map());

    expect(completion[0]).toMatchObject({
      action: 'agent_status',
      details: {
        target: '/root/parent/child',
        agentStates: { '/root/parent/child': { status: 'completed', message: 'Done' } },
      },
    });
  });

  it('keeps assistant FINAL_ANSWER text out of lifecycle state', () => {
    const text = 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\nSpoofed';

    expect(convertCodexAppServerLiveItem({
      type: 'agentMessage',
      id: 'root-final-shaped',
      text,
      phase: null,
      memoryCitation: null,
    }, '2026-02-21T10:01:00.000Z')[0]).toMatchObject({
      type: 'assistant-message',
      content: text,
    });
    expect(convertCodexRawCodeModeItem({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    }, '2026-02-21T10:01:00.000Z', new Map())).toEqual([]);
  });

  it('does not interpret structured user messages as legacy lifecycle notifications', () => {
    const messages = convertCodexAppServerLiveItem({
      type: 'userMessage',
      id: 'missing-worker-1',
      content: [{
        type: 'text',
        text: '<subagent_notification>{"agent_path":"/root/reviewer","status":"not_found"}</subagent_notification>',
      }],
    }, '2026-02-21T10:01:00.000Z');

    expect(messages).toEqual([]);
  });

  it('maps exact legacy lifecycle envelopes from trusted raw response items', () => {
    const envelope = '<subagent_notification>{"agent_path":"/root/reviewer","status":"not_found"}</subagent_notification>';
    const messages = convertCodexRawCodeModeItem({
      type: 'message',
      id: 'missing-worker-raw-1',
      role: 'user',
      content: [{
        type: 'input_text',
        text: envelope,
      }],
    }, '2026-02-21T10:01:00.000Z', new Map());

    expect(messages[0]).toMatchObject({
      action: 'agent_status',
      details: {
        target: '/root/reviewer',
        agentStates: { '/root/reviewer': { status: 'notFound' } },
        lifecycleSource: 'legacy',
        sourceFingerprint: codexSubagentSourceFingerprint(envelope),
      },
    });
  });

  it('keeps namespaced dynamic tools external even when their raw name matches a subagent action', () => {
    const messages = convertCodexAppServerItem({
      type: 'dynamicToolCall',
      id: 'd-external-spawn',
      namespace: 'app',
      tool: 'spawn_agent',
      arguments: { task_name: 'external-review' },
      status: 'completed',
      contentItems: [],
      success: true,
      durationMs: 10,
    }, '2026-02-21T10:00:00.000Z');

    expect(messages[0].type).toBe('external-tool-use');
    expect(messages[0].namespace).toBe('app');
    expect(messages[0].name).toBe('spawn_agent');
  });
});

describe('Codex app-server approvals', () => {
  it('maps command decisions to app-server responses', () => {
    const pending = createPendingApproval('chat-1', {
      id: 5,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'rm file' },
    });

    expect(buildApprovalResponse(pending, { allow: true })).toEqual({ decision: 'accept' });
    expect(buildApprovalResponse(pending, { allow: true, alwaysAllow: true })).toEqual({ decision: 'acceptForSession' });
    expect(buildApprovalResponse(pending, { allow: false })).toEqual({ decision: 'decline' });
  });

  it('uses approval identity for command and write-stdin reviews', () => {
    const command = createPendingApproval('chat-1', {
      id: 'command-review',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'parent-command',
        approvalId: 'zsh-review',
        command: 'printf ready',
      },
    });
    const writeStdin = createPendingApproval('chat-1', {
      id: 'stdin-review',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'parent-command',
        approvalId: 'stdin-approval',
        kind: 'writeStdin',
        reason: 'Send confirmation',
      },
    });

    expect(buildApprovalMessage(command).requestedTool).toMatchObject({
      type: 'bash-tool-use',
      toolId: 'zsh-review',
      command: 'printf ready',
    });
    expect(buildApprovalMessage(writeStdin).requestedTool).toMatchObject({
      type: 'write-stdin-tool-use',
      toolId: 'stdin-approval',
      input: { itemId: 'parent-command', reason: 'Send confirmation' },
    });
    expect(buildApprovalResponse(writeStdin, { allow: true, alwaysAllow: true }))
      .toEqual({ decision: 'accept' });
    expect(buildApprovalResponse(writeStdin, { allow: false }))
      .toEqual({ decision: 'cancel' });
  });

  it('rejects write-stdin reviews without distinct approval identity', () => {
    const pending = createPendingApproval('chat-1', {
      id: 'stdin-review',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'parent-command',
        kind: 'writeStdin',
      },
    });

    expect(() => buildApprovalMessage(pending)).toThrow('requires approvalId and itemId');
    expect(() => buildApprovalResponse(pending, { allow: true })).toThrow('requires approvalId');
  });

  it('maps permission grants and denials', () => {
    const pending = createPendingApproval('chat-1', {
      id: 6,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'perm-1',
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });

    expect(buildApprovalResponse(pending, { allow: true, alwaysAllow: true })).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    });
    expect(buildApprovalResponse(pending, { allow: false })).toEqual({ permissions: {}, scope: 'turn' });
  });
});

describe('CodexAppServerRuntime', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createActiveGoalQueue(provider, codexGoalCommand, operation) {
    return new ChatExecutionCoordinator(
      tmpDir,
      {
        runAgentTurn: async () => { throw new Error('must use active delivery'); },
        submitGoalControl: (_chatId, command, options, beforeDelivery) => provider.submitGoalControl(makeRequest({
          ...options,
          agentSessionId: 'thread-1',
          command,
          codexGoalCommand,
          nativePath: null,
          ...(operation ? { operation } : {}),
        }), beforeDelivery),
        abortSession: async () => false,
        isChatRunning: () => provider.isRunning('thread-1'),
      },
      {
        admitInput: async () => ({ inserted: true }),
        admitQueuedInput: () => ({ inserted: true }),
        discardPreparedInput: () => {},
      },
      () => ({
        model: 'gpt-5.4-codex',
        permissionMode: 'default',
        thinkingMode: 'medium',
        claudeThinkingMode: 'off',
        ampAgentMode: 'default',
      }),
      () => true,
      new InMemoryChatExecutionControlRepository('server-instance-test'),
    );
  }

  function makeThreadSettings(overrides = {}) {
    return {
      cwd: '/repo',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/repo'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      activePermissionProfile: null,
      model: 'gpt-5.4-codex',
      modelProvider: 'openai',
      serviceTier: null,
      effort: 'medium',
      summary: 'auto',
      collaborationMode: null,
      multiAgentMode: 'explicitRequestOnly',
      personality: null,
      ...overrides,
    };
  }

  async function startSettingsSession(runtimeOptions = {}) {
    const nativePath = path.join(tmpDir, 'settings-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({
          id: 'thread-1',
          path: nativePath,
          model: 'gpt-5.4-codex',
          reasoningEffort: 'medium',
        }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
        reasoningEffort: 'medium',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      ...runtimeOptions,
    });
    const published = collectOperation();
    const started = await provider.startSession(makeRequest({ operation: published.operation }));
    return { fake, provider, published, started };
  }

  function emitThreadSettings(fake, overrides = {}, threadId = 'thread-1') {
    fake.emit('notification', {
      method: 'thread/settings/updated',
      params: {
        threadId,
        threadSettings: makeThreadSettings(overrides),
      },
    });
  }

  it('starts a turn and waits for the app-server transcript path before resolving', async () => {
    const nativePath = path.join(tmpDir, 'thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });

    await expect(provider.startSession(makeRequest())).resolves.toEqual({
      agentSessionId: 'thread-1',
      nativePath,
    });
    expect(fake.startThread).toHaveBeenCalledTimes(1);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);
  });

  it('keeps app-server stderr content out of diagnostics', async () => {
    const privateContent = 'private-codex-transcript-content';
    const diagnostics = [];
    const nativePath = path.join(tmpDir, 'private-diagnostics.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-private-diagnostics', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-private-diagnostics', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      logger: {
        debug(...args) { diagnostics.push(args); },
        info(...args) { diagnostics.push(args); },
        warn(...args) { diagnostics.push(args); },
        error(...args) { diagnostics.push(args); },
      },
    });

    await provider.startSession(makeRequest());
    fake.emit('stderr', privateContent);

    expect(JSON.stringify(diagnostics)).not.toContain(privateContent);
  });

  it('steers an ordinary active turn once with its expected native identity', async () => {
    const nativePath = path.join(tmpDir, 'strict-steer-thread.jsonl');
    const prepared = mock(async () => undefined);
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-active', status: 'inProgress' }) };
      },
      steerTurn: async ({ expectedTurnId }, options) => {
        await options.prepareDelivery();
        return { turnId: expectedTurnId };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
    });
    await provider.startSession(makeRequest());

    await expect(provider.steer({
      chatId: 'chat-1',
      projectPath: '/repo',
      agentSessionId: 'thread-1',
      nativeSession: null,
      target: provider.captureSteerTarget('thread-1'),
      input: 'focus on the failing test',
      clientMessageId: 'message-steer',
      prepareDelivery: prepared,
    })).resolves.toEqual({ kind: 'accepted' });

    expect(prepared).toHaveBeenCalledOnce();
    expect(fake.steerTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      expectedTurnId: 'turn-active',
      input: [{ type: 'text', text: 'focus on the failing test', text_elements: [] }],
      clientUserMessageId: 'message-steer',
    }, expect.objectContaining({ prepareDelivery: prepared }));
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
  });

  it('maps a native expected-turn mismatch without retrying another turn', async () => {
    const nativePath = path.join(tmpDir, 'strict-steer-mismatch.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-active', status: 'inProgress' }) };
      },
      steerTurn: async () => {
        throw new CodexAppServerRpcError(
          'expected active turn id `turn-active` but found `turn-replacement`',
          -32602,
        );
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
    });
    await provider.startSession(makeRequest());

    await expect(provider.steer({
      chatId: 'chat-1',
      projectPath: '/repo',
      agentSessionId: 'thread-1',
      nativeSession: null,
      target: provider.captureSteerTarget('thread-1'),
      input: 'too late',
      clientMessageId: 'message-steer',
      prepareDelivery: async () => undefined,
    })).resolves.toEqual({
      kind: 'rejected',
      reason: 'turn-changed',
      message: 'The active Codex turn changed',
    });
    expect(fake.steerTurn).toHaveBeenCalledTimes(1);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects when the native turn changes after target capture but before delivery', async () => {
    const nativePath = path.join(tmpDir, 'strict-steer-captured-turn.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-captured', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
    });
    await provider.startSession(makeRequest());
    const target = provider.captureSteerTarget('thread-1');
    fake.emit('notification', {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: makeTurn({ id: 'turn-replacement', status: 'inProgress' }),
      },
    });

    await expect(provider.steer({
      chatId: 'chat-1',
      projectPath: '/repo',
      agentSessionId: 'thread-1',
      nativeSession: null,
      target,
      input: 'must stay on the captured turn',
      clientMessageId: 'message-steer',
      prepareDelivery: async () => undefined,
    })).resolves.toEqual({
      kind: 'rejected',
      reason: 'turn-changed',
      message: 'The active Codex turn changed',
    });
    expect(fake.steerTurn).not.toHaveBeenCalled();
  });

  it('maps native review and compaction rejection without waiting or retrying', async () => {
    for (const turnKind of ['review', 'compact']) {
      const nativePath = path.join(tmpDir, `strict-steer-${turnKind}.jsonl`);
      const fake = new FakeClient({
        startThread: async () => ({
          thread: makeThread({ id: `thread-${turnKind}`, path: nativePath }),
          model: 'gpt',
          modelProvider: 'openai',
          serviceTier: null,
          cwd: '/repo',
        }),
        startTurn: async () => {
          await fs.writeFile(nativePath, '{}\n');
          return { turn: makeTurn({ id: `turn-${turnKind}`, status: 'inProgress' }) };
        },
        steerTurn: async () => {
          throw new CodexAppServerRpcError(
            `cannot steer a ${turnKind} turn`,
            -32602,
            { codexErrorInfo: { activeTurnNotSteerable: { turnKind } } },
          );
        },
      });
      const provider = createRuntime({
        createClient: () => fake,
        materializationTimeoutMs: 20,
      });
      await provider.startSession(makeRequest({ chatId: `chat-${turnKind}` }));

      await expect(provider.steer({
        chatId: `chat-${turnKind}`,
        projectPath: '/repo',
        agentSessionId: `thread-${turnKind}`,
        nativeSession: null,
        target: provider.captureSteerTarget(`thread-${turnKind}`),
        input: 'focus here',
        clientMessageId: `message-${turnKind}`,
        prepareDelivery: async () => undefined,
      })).resolves.toEqual({
        kind: 'rejected',
        reason: 'turn-not-steerable',
        message: 'The active Codex turn cannot be steered',
      });
      expect(fake.steerTurn).toHaveBeenCalledTimes(1);
      expect(fake.startTurn).toHaveBeenCalledTimes(1);
    }
  });

  it('maps the pinned structured oversized-input rejection to validation', async () => {
    const nativePath = path.join(tmpDir, 'strict-steer-input-too-large.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-active', status: 'inProgress' }) };
      },
      steerTurn: async () => {
        throw new CodexAppServerRpcError(
          'Input exceeds the maximum length of 1048576 bytes.',
          -32602,
          { input_error_code: 'input_too_large' },
        );
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
    });
    await provider.startSession(makeRequest());

    await expect(provider.steer({
      chatId: 'chat-1',
      projectPath: '/repo',
      agentSessionId: 'thread-1',
      nativeSession: null,
      target: provider.captureSteerTarget('thread-1'),
      input: 'oversized input',
      clientMessageId: 'message-steer',
      prepareDelivery: async () => undefined,
    })).resolves.toEqual({
      kind: 'rejected',
      reason: 'invalid-input',
      message: 'Codex rejected the steering input',
    });
  });

  it('treats an unexpected native acknowledgement identity as unknown without retrying', async () => {
    const nativePath = path.join(tmpDir, 'strict-steer-unexpected-ack.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-active', status: 'inProgress' }) };
      },
      steerTurn: async (_params, options) => {
        await options.prepareDelivery();
        return { turnId: 'turn-unexpected' };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
    });
    await provider.startSession(makeRequest());

    await expect(provider.steer({
      chatId: 'chat-1',
      projectPath: '/repo',
      agentSessionId: 'thread-1',
      nativeSession: null,
      target: provider.captureSteerTarget('thread-1'),
      input: 'focus here',
      clientMessageId: 'message-steer',
      prepareDelivery: async () => undefined,
    })).resolves.toEqual({
      kind: 'failed',
      outcome: 'unknown',
      message: 'Codex acknowledged steering for an unexpected turn',
    });
    expect(fake.steerTurn).toHaveBeenCalledTimes(1);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
  });

  it('does not create a thread when admission closes during client startup', async () => {
    const connected = createDeferred();
    const connectStarted = createDeferred();
    const fake = new FakeClient({
      connect: async () => {
        connectStarted.resolve();
        await connected.promise;
        return { userAgent: 'codex', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const admission = new AbortController();
    const markStarted = mock();
    const start = provider.startSession(makeRequest({
      executionAdmission: { signal: admission.signal, markStarted },
    }));
    await connectStarted.promise;

    admission.abort(new Error('server is shutting down'));
    connected.resolve();

    await expect(start).rejects.toThrow('server is shutting down');
    expect(fake.startThread).not.toHaveBeenCalled();
    expect(markStarted).not.toHaveBeenCalled();
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('emits pre-session failures before waiting for graceful shutdown', async () => {
    const operations = [
      (provider, operation) => provider.startSession(makeRequest({ operation })),
      (provider, operation) => provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        nativePath: null,
        operation,
      })),
      (provider, operation) => provider.compact(makeRequest({
        agentSessionId: 'thread-1',
        nativePath: null,
        operation,
      })),
    ];

    for (const operate of operations) {
      const shutdown = createDeferred();
      const fake = new FakeClient({
        connect: async () => {
          throw new Error('app-server startup failed');
        },
        shutdown: () => shutdown.promise,
      });
      const provider = createRuntime({ createClient: () => fake });
      const published = collectOperation();
      const failed = published.waitForEvent(
        (event) => event.type === 'run-ended' && event.outcome === 'failed',
      );

      const operation = operate(provider, published.operation);
      await expect(failed).resolves.toMatchObject({
        error: { message: 'Codex error: app-server startup failed' },
      });
      expect(fake.shutdown).toHaveBeenCalledTimes(1);
      shutdown.resolve();
      await expect(operation).rejects.toThrow('app-server startup failed');
    }
  });

  it('keeps an interrupted turn attached until the provider terminal notification', async () => {
    const commandItem = {
      type: 'commandExecution',
      id: 'command-after-interrupt',
      command: 'printf persisted',
      cwd: '/repo',
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'persisted',
      exitCode: 0,
      durationMs: 12,
    };
    const fake = new FakeClient();
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      nativePath: null,
      operation: published.operation,
    }));
    await expect(provider.abort('thread-1')).resolves.toBe(true);

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(provider.getRunningSessions()).toMatchObject([{ id: 'thread-1', status: 'interrupting' }]);
    expect(fake.shutdown).not.toHaveBeenCalled();

    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: commandItem,
      },
    });

    const emitted = publishedMessages(published.events);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toBeInstanceOf(BashToolUseMessage);
    expect(emitted[1]).toBeInstanceOf(ToolResultMessage);
    expect(emitted[1]).toMatchObject({
      toolId: 'command-after-interrupt',
      content: { raw: 'persisted' },
      isError: false,
    });
    expect(emitted.map(getNativeMessageRevisionSource)).toEqual([
      {
        entryId: 'turn:turn-1:tool:command-after-interrupt',
        withinSourceOrdinal: 0,
      },
      {
        entryId: 'turn:turn-1:tool:command-after-interrupt',
        withinSourceOrdinal: 1,
      },
    ]);

    const terminal = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: makeTurn({ status: 'interrupted' }),
      },
    });
    await terminal;

    expect(terminalEvents(published.events)).toEqual([
      expect.objectContaining({ outcome: 'finished' }),
    ]);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });



  // The terminal can arrive inside interruptTurn(). The turn must still settle exactly once,
  // and the native rows this races against are never recovered into the live tail.
  it('settles once when a completed terminal notification wins the interrupt response race', async () => {
    const nativePath = path.join(tmpDir, 'interrupt-response-race.jsonl');
    await writeJsonl(nativePath, commandHistoryEntries('prior-command', 'printf prior', 'prior'));
    let fake;
    fake = new FakeClient({
      interruptTurn: async () => {
        await writeJsonl(nativePath, [
          ...commandHistoryEntries('prior-command', 'printf prior', 'prior'),
          ...commandHistoryEntries('race-command', 'printf raced', 'raced').slice(2),
        ]);
        fake.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: makeTurn({ status: 'completed' }),
          },
        });
        return {};
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      nativePath,
      operation: published.operation,
    }));
    const terminal = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    await expect(provider.abort('thread-1')).resolves.toBe(true);
    await terminal;

    expect(publishedMessages(published.events).filter(
      (message) => message.toolId === 'race-command',
    )).toEqual([]);
    expect(terminalEvents(published.events)).toEqual([
      expect.objectContaining({ outcome: 'finished' }),
    ]);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('restores running status when the interrupt request is rejected', async () => {
    const fake = new FakeClient({
      interruptTurn: async () => {
        throw new Error('interrupt rejected');
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({ agentSessionId: 'thread-1', nativePath: null }));

    await expect(provider.abort('thread-1')).resolves.toBe(false);
    expect(provider.getRunningSessions()).toMatchObject([{ id: 'thread-1', status: 'running' }]);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('does not restore a managed goal turn that completes before its start response', async () => {
    const nativePath = path.join(tmpDir, 'completed-before-start-response-goal-thread.jsonl');
    let fake;
    fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            goal: makeGoal('thread-1', 'Ship the feature', 'active'),
          },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ status: 'inProgress' }) },
        });
        fake.emit('notification', {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: makeTurn() },
        });
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.startSession(makeRequest({ operation: published.operation }));

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        goal: makeGoal('thread-1', 'Ship the feature', 'complete'),
      },
    });
    await finished;
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('finishes a resumed unmanaged turn that completes before its start response', async () => {
    let fake;
    fake = new FakeClient({
      startTurn: async () => {
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ status: 'inProgress' }) },
        });
        fake.emit('notification', {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: makeTurn() },
        });
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      nativePath: null,
      operation: published.operation,
    }));
    await finished;

    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('keeps the turn running when Codex reports a retryable stream error', async () => {
    const nativePath = path.join(tmpDir, 'retryable-error-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    fake.emit('notification', {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: {
          message: 'Reconnecting... 1/5',
          codexErrorInfo: null,
          additionalDetails: 'Request to upstream timed out',
        },
      },
    });
    fake.emit('notification', {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: {
          message: 'Reconnecting... 2/5',
          codexErrorInfo: null,
          additionalDetails: 'Request to upstream timed out',
        },
      },
    });

    expect(publishedMessages(published.events).map((message) => message.content)).toEqual([
      'Reconnecting... 1/5',
      'Reconnecting... 2/5',
    ]);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(failureMessages(published.events)).toEqual([]);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn() },
    });
    await finished;
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('ignores lifecycle notifications emitted by a stale app-server client', async () => {
    const nativePath = path.join(tmpDir, 'stale-client-error-thread.jsonl');
    const staleClient = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'old-turn', status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const activeClient = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'active-turn', status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const clients = [staleClient, activeClient];
    const provider = createRuntime({ createClient: () => clients.shift(), materializationTimeoutMs: 20 });
    const oldPublished = collectOperation('chat-1', 'run-old');
    const activePublished = collectOperation('chat-1', 'run-active');

    await provider.startSession(makeRequest({ operation: oldPublished.operation }));
    const oldFinished = oldPublished.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    staleClient.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'old-turn' }) },
    });
    await oldFinished;
    await provider.startSession(makeRequest({ operation: activePublished.operation }));

    staleClient.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'stale-started-turn', status: 'inProgress' }) },
    });
    staleClient.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'active-turn',
        item: { type: 'agentMessage', id: 'stale-message', text: 'Message from stale client', phase: null, memoryCitation: null },
      },
    });
    staleClient.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'active-turn',
        item: { type: 'custom_tool_call', call_id: 'stale-call', name: 'exec', input: 'text("stale")' },
      },
    });
    staleClient.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'active-turn', goal: makeGoal('thread-1', 'Stale goal') },
    });
    staleClient.emit('notification', {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'active-turn',
        willRetry: false,
        error: {
          message: 'Error from stale client',
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    });
    staleClient.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'active-turn' }) },
    });

    expect(publishedMessages(oldPublished.events)).toEqual([]);
    expect(publishedMessages(activePublished.events)).toEqual([]);
    expect(failureMessages(oldPublished.events)).toEqual([]);
    expect(failureMessages(activePublished.events)).toEqual([]);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(activeClient.shutdown).not.toHaveBeenCalled();

    const activeFinished = activePublished.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    activeClient.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'active-turn' }) },
    });
    await activeFinished;
  });

  it('ignores lifecycle notifications for a turn that is no longer active', async () => {
    const nativePath = path.join(tmpDir, 'stale-turn-error-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'active-turn', status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    fake.emit('notification', {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'stale-turn',
        willRetry: false,
        error: {
          message: 'Error from stale turn',
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    });
    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'stale-turn',
        item: { type: 'agentMessage', id: 'stale-message', text: 'Message from stale turn', phase: null, memoryCitation: null },
      },
    });
    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'stale-turn',
        item: { type: 'custom_tool_call', call_id: 'stale-call', name: 'exec', input: 'text("stale")' },
      },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'stale-turn' }) },
    });

    expect(publishedMessages(published.events)).toEqual([]);
    expect(failureMessages(published.events)).toEqual([]);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'active-turn' }) },
    });
    await finished;
  });

  it('retries a capacity failure without appending another user message', async () => {
    const nativePath = path.join(tmpDir, 'capacity-retry-thread.jsonl');
    let turnNumber = 0;
    let resolveRetryStarted;
    const retryStarted = new Promise((resolve) => { resolveRetryStarted = resolve; });
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async (params) => {
        await fs.writeFile(nativePath, '{}\n');
        turnNumber += 1;
        if (turnNumber === 2) resolveRetryStarted(params);
        return { turn: makeTurn({ id: `turn-${turnNumber}`, status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
    });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    emitCapacityFailure(fake, 'turn-1');

    await expect(retryStarted).resolves.toEqual({ threadId: 'thread-1', input: [] });
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(failureMessages(published.events)).toEqual([]);

    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-2' }) },
    });
    await finished;
    expect(fake.startTurn).toHaveBeenCalledTimes(2);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('resumes a blocked goal after a capacity failure without duplicating input', async () => {
    const nativePath = path.join(tmpDir, 'goal-capacity-retry-thread.jsonl');
    let fake;
    let resolveRetryStarted;
    const retryStarted = new Promise((resolve) => { resolveRetryStarted = resolve; });
    fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
      setThreadGoalStatus: async (threadId, status) => {
        const goal = makeGoal(threadId, 'Finish the work', status);
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: { threadId, turnId: null, goal },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: {
            threadId,
            turn: makeTurn({ id: 'turn-2', status: 'inProgress', completedAt: null, durationMs: null }),
          },
        });
        resolveRetryStarted({ threadId, status });
        return { goal };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
    });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work') },
    });

    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work', 'blocked') },
    });
    emitCapacityFailure(fake, 'turn-1');

    await expect(retryStarted).resolves.toEqual({ threadId: 'thread-1', status: 'active' });
    expect(fake.setThreadGoalStatus).toHaveBeenCalledWith('thread-1', 'active');
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(failureMessages(published.events)).toEqual([]);

    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-2', goal: makeGoal('thread-1', 'Finish the work', 'complete') },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-2' }) },
    });
    await finished;
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('retries when the initial unmanaged turn fails before its start response resolves', async () => {
    const nativePath = path.join(tmpDir, 'initial-same-chunk-capacity-retry-thread.jsonl');
    let fake;
    let turnNumber = 0;
    fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        turnNumber += 1;
        const turn = makeTurn({
          id: `turn-${turnNumber}`,
          status: 'inProgress',
          completedAt: null,
          durationMs: null,
        });
        if (turnNumber === 1) {
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn },
          });
          emitCapacityFailure(fake, turn.id);
        }
        return { turn };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });
    const published = collectOperation();

    await provider.startSession(makeRequest({ operation: published.operation }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.startTurn).toHaveBeenCalledTimes(2);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-2' }) },
    });
    await finished;
  });

  it('retries when an ordinary managed turn fails before its start response resolves', async () => {
    const retryStarted = createDeferred();
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        const goal = makeGoal(threadId, params.objective);
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: { threadId, turnId: 'goal-turn', goal },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        });
        return { goal };
      },
      steerTurn: async () => { throw new Error('no active turn to steer'); },
      startTurn: async () => {
        const turn = makeTurn({ id: 'user-turn', status: 'inProgress' });
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn },
        });
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: turn.id,
            goal: makeGoal('thread-1', 'Long-running work', 'blocked'),
          },
        });
        emitCapacityFailure(fake, turn.id);
        return { turn };
      },
      setThreadGoalStatus: async (threadId, status) => {
        const goal = makeGoal(threadId, 'Long-running work', status);
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: { threadId, turnId: 'retry-turn', goal },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'retry-turn', status: 'inProgress' }) },
        });
        retryStarted.resolve();
        return { goal };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    const controlPublished = collectOperation('chat-1', 'run-control');
    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Continue through capacity recovery',
      nativePath: null,
      operation: controlPublished.operation,
    }))).resolves.toBe(true);
    await retryStarted.promise;

    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(fake.setThreadGoalStatus).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = controlPublished.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'retry-turn',
        goal: makeGoal('thread-1', 'Long-running work', 'complete'),
      },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'retry-turn' }) },
    });
    await finished;
  });

  it('retries a resumed goal when its turn fails before the status response resolves', async () => {
    const retryStarted = createDeferred();
    let fake;
    let statusCallCount = 0;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: makeGoal('thread-1', 'Long-running work', 'blocked') }),
      setThreadGoalStatus: async (threadId, status) => {
        statusCallCount += 1;
        const turnId = `goal-turn-${statusCallCount}`;
        const activeGoal = makeGoal(threadId, 'Long-running work', status);
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: { threadId, turnId, goal: activeGoal },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: turnId, status: 'inProgress' }) },
        });
        if (statusCallCount === 1) {
          fake.emit('notification', {
            method: 'thread/goal/updated',
            params: {
              threadId,
              turnId,
              goal: makeGoal(threadId, 'Long-running work', 'blocked'),
            },
          });
          emitCapacityFailure(fake, turnId);
        } else {
          retryStarted.resolve();
        }
        return { goal: activeGoal };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });
    const published = collectOperation();

    const running = provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'resume' },
      nativePath: null,
      operation: published.operation,
    }));
    await retryStarted.promise;
    await running;

    expect(fake.setThreadGoalStatus).toHaveBeenCalledTimes(2);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'goal-turn-2',
        goal: makeGoal('thread-1', 'Long-running work', 'complete'),
      },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn-2' }) },
    });
    await finished;
  });

  it('continues an unmanaged retry when its turn fails before the retry response resolves', async () => {
    const nativePath = path.join(tmpDir, 'same-chunk-capacity-retry-thread.jsonl');
    const finalRetryStarted = createDeferred();
    let fake;
    let turnNumber = 0;
    fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        turnNumber += 1;
        const turn = makeTurn({
          id: `turn-${turnNumber}`,
          status: 'inProgress',
          completedAt: null,
          durationMs: null,
        });
        if (turnNumber === 2) {
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn },
          });
          emitCapacityFailure(fake, turn.id);
        } else if (turnNumber === 3) {
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn },
          });
          finalRetryStarted.resolve();
        }
        return { turn };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    emitCapacityFailure(fake, 'turn-1');
    await finalRetryStarted.promise;

    expect(fake.startTurn).toHaveBeenCalledTimes(3);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-3' }) },
    });
    await finished;
  });

  it('continues a managed retry when its turn fails before the goal response resolves', async () => {
    const nativePath = path.join(tmpDir, 'same-chunk-goal-capacity-retry-thread.jsonl');
    let fake;
    let goalRetryCount = 0;
    fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
      setThreadGoalStatus: async (threadId, status) => {
        goalRetryCount += 1;
        const turnId = `turn-${goalRetryCount + 1}`;
        const activeGoal = makeGoal(threadId, 'Finish the work', status);
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: { threadId, turnId: null, goal: activeGoal },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: {
            threadId,
            turn: makeTurn({ id: turnId, status: 'inProgress', completedAt: null, durationMs: null }),
          },
        });
        if (goalRetryCount === 1) {
          fake.emit('notification', {
            method: 'thread/goal/updated',
            params: { threadId, turnId, goal: makeGoal(threadId, 'Finish the work', 'blocked') },
          });
          emitCapacityFailure(fake, turnId);
        }
        return { goal: activeGoal };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work') },
    });
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work', 'blocked') },
    });

    emitCapacityFailure(fake, 'turn-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.setThreadGoalStatus).toHaveBeenCalledTimes(2);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-3', goal: makeGoal('thread-1', 'Finish the work', 'complete') },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-3' }) },
    });
    await finished;
  });

  it('serializes buffered capacity retries after resumed initial input delivery', async () => {
    for (const goalStatus of ['blocked', null]) {
      const controlledDelay = createControlledDelay();
      const initialDelivery = createDeferred();
      const initialDeliveryStarted = createDeferred();
      let fake;
      fake = new FakeClient({
        resumeThread: async () => {
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: makeTurn({ id: 'restored-turn', status: 'inProgress' }) },
          });
          if (goalStatus) {
            fake.emit('notification', {
              method: 'thread/goal/updated',
              params: {
                threadId: 'thread-1',
                turnId: 'restored-turn',
                goal: makeGoal('thread-1', 'Finish the work', goalStatus),
              },
            });
          }
          emitCapacityFailure(fake, 'restored-turn');
          return { thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
        },
        getThreadGoal: async () => ({
          goal: goalStatus ? makeGoal('thread-1', 'Finish the work') : null,
        }),
        startTurn: async (params) => {
          if (params.input.length === 0) {
            return { turn: makeTurn({ id: 'empty-retry-turn', status: 'inProgress' }) };
          }
          initialDeliveryStarted.resolve(params);
          await initialDelivery.promise;
          return { turn: makeTurn({ id: 'user-turn', status: 'inProgress' }) };
        },
        setThreadGoalStatus: async (threadId, status) => ({
          goal: makeGoal(threadId, 'Finish the work', status),
        }),
      });
      const provider = createRuntime({
        createClient: () => fake,
        capacityRetryDelaysMs: [25],
        capacityRetryDelay: controlledDelay.wait,
      });
      const published = collectOperation();

      const running = provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        command: 'Deliver this before retrying',
        nativePath: null,
        operation: published.operation,
      }));
      await expect(initialDeliveryStarted.promise).resolves.toMatchObject({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Deliver this before retrying', text_elements: [] }],
      });
      await expect(controlledDelay.started).resolves.toBe(25);

      controlledDelay.release();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.startTurn).toHaveBeenCalledTimes(1);
      expect(fake.setThreadGoalStatus).not.toHaveBeenCalled();

      initialDelivery.resolve();
      await running;
      await Promise.resolve();
      expect(fake.startTurn).toHaveBeenCalledTimes(1);
      expect(fake.setThreadGoalStatus).not.toHaveBeenCalled();

      const finished = published.waitForEvent(
        (event) => event.type === 'run-ended' && event.outcome === 'finished',
      );
      fake.emit('notification', {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: makeTurn({ id: 'user-turn' }) },
      });
      await finished;
    }
  });

  it('does not reactivate a blocked goal after pause or clear is accepted during capacity backoff', async () => {
    for (const control of ['pause', 'clear']) {
      const nativePath = path.join(tmpDir, `${control}-during-capacity-backoff.jsonl`);
      const controlledDelay = createControlledDelay();
      const goalCalls = [];
      const fake = new FakeClient({
        startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
        startTurn: async () => {
          await fs.writeFile(nativePath, '{}\n');
          return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
        },
        setThreadGoalStatus: async (threadId, status) => {
          goalCalls.push(status);
          return { goal: makeGoal(threadId, 'Finish the work', status) };
        },
        clearThreadGoal: async () => {
          goalCalls.push('clear');
          return { cleared: true };
        },
      });
      const provider = createRuntime({
        createClient: () => fake,
        materializationTimeoutMs: 20,
        capacityRetryDelaysMs: [25],
        capacityRetryDelay: controlledDelay.wait,
      });
      await provider.startSession(makeRequest());
      fake.emit('notification', {
        method: 'thread/goal/updated',
        params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work') },
      });
      fake.emit('notification', {
        method: 'thread/goal/updated',
        params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work', 'blocked') },
      });
      emitCapacityFailure(fake, 'turn-1');
      await expect(controlledDelay.started).resolves.toBe(25);

      await expect(provider.submitGoalControl(makeRequest({
        agentSessionId: 'thread-1',
        command: `/goal ${control}`,
        codexGoalCommand: { kind: control },
        nativePath: null,
      }))).resolves.toBe(true);

      controlledDelay.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(goalCalls).toEqual([control === 'pause' ? 'paused' : 'clear']);
      expect(provider.isRunning('thread-1')).toBe(false);
      expect(fake.shutdown).not.toHaveBeenCalled();
    }
  });

  it('does not retry a blocked goal after ordinary input starts a turn during capacity backoff', async () => {
    const nativePath = path.join(tmpDir, 'input-during-capacity-backoff.jsonl');
    const controlledDelay = createControlledDelay();
    let turnNumber = 0;
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        turnNumber += 1;
        return { turn: makeTurn({ id: `turn-${turnNumber}`, status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [25],
      capacityRetryDelay: controlledDelay.wait,
    });
    await provider.startSession(makeRequest());
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work') },
    });
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work', 'blocked') },
    });
    emitCapacityFailure(fake, 'turn-1');
    await expect(controlledDelay.started).resolves.toBe(25);

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Investigate the next failure',
      nativePath: null,
    }))).resolves.toBe(true);

    controlledDelay.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.setThreadGoalStatus).not.toHaveBeenCalled();
    expect(fake.startTurn).toHaveBeenCalledTimes(2);
    expect(fake.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Investigate the next failure', text_elements: [] }],
    }));
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('caps capacity retries at three', async () => {
    const nativePath = path.join(tmpDir, 'capacity-exhausted-thread.jsonl');
    let turnNumber = 0;
    const retryResolvers = [];
    const retryStarts = Array.from({ length: 3 }, () => new Promise((resolve) => retryResolvers.push(resolve)));
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async (params) => {
        await fs.writeFile(nativePath, '{}\n');
        turnNumber += 1;
        retryResolvers[turnNumber - 2]?.(params);
        return { turn: makeTurn({ id: `turn-${turnNumber}`, status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0, 0],
    });
    const published = collectOperation();
    const failed = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'failed',
    );
    await provider.startSession(makeRequest({ operation: published.operation }));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      emitCapacityFailure(fake, `turn-${attempt + 1}`);
      if (attempt < 3) {
        await expect(retryStarts[attempt]).resolves.toEqual({ threadId: 'thread-1', input: [] });
      }
    }

    await expect(failed).resolves.toMatchObject({
      error: { message: 'Selected model is at capacity. Please try a different model.' },
    });
    expect(fake.startTurn).toHaveBeenCalledTimes(4);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('fails a blocked goal after three capacity retries', async () => {
    const nativePath = path.join(tmpDir, 'goal-capacity-exhausted-thread.jsonl');
    let fake;
    let turnNumber = 1;
    const retryResolvers = [];
    const retryStarts = Array.from({ length: 3 }, () => new Promise((resolve) => retryResolvers.push(resolve)));
    fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
      setThreadGoalStatus: async (threadId, status) => {
        turnNumber += 1;
        const goal = makeGoal(threadId, 'Finish the work', status);
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: { threadId, turnId: null, goal },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: {
            threadId,
            turn: makeTurn({ id: `turn-${turnNumber}`, status: 'inProgress', completedAt: null, durationMs: null }),
          },
        });
        retryResolvers[turnNumber - 2]?.({ threadId, status });
        return { goal };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
    });
    const published = collectOperation();
    const failed = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'failed',
    );
    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', goal: makeGoal('thread-1', 'Finish the work') },
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const turnId = `turn-${attempt + 1}`;
      fake.emit('notification', {
        method: 'thread/goal/updated',
        params: { threadId: 'thread-1', turnId, goal: makeGoal('thread-1', 'Finish the work', 'blocked') },
      });
      emitCapacityFailure(fake, turnId);
      if (attempt < 3) {
        await expect(retryStarts[attempt]).resolves.toEqual({ threadId: 'thread-1', status: 'active' });
      }
    }

    await expect(failed).resolves.toMatchObject({
      error: { message: 'Selected model is at capacity. Please try a different model.' },
    });
    expect(fake.setThreadGoalStatus).toHaveBeenCalledTimes(3);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('ends the turn when Codex reports a non-retryable error', async () => {
    const nativePath = path.join(tmpDir, 'terminal-error-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const published = collectOperation();
    const failed = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'failed',
    );
    await provider.startSession(makeRequest({ operation: published.operation }));

    fake.emit('notification', {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: {
          message: 'Codex turn failed',
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    });

    await expect(failed).resolves.toMatchObject({ error: { message: 'Codex turn failed' } });
    const emitted = publishedMessages(published.events);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'error', content: 'Codex turn failed' });
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('streams raw Code Mode calls and their paired outputs through the shared contract', async () => {
    const nativePath = path.join(tmpDir, 'live-exec-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call-exec-1',
          input: 'const result = await tools.exec_command({cmd: "pwd"}); text(result.output);',
        },
      },
    });
    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call-unrelated',
          output: 'ignored',
        },
      },
    });
    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'custom_tool_call_output',
          call_id: 'call-exec-1',
          output: [{ type: 'input_text', text: '1' }],
        },
      },
    });

    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call-wait-1',
          arguments: '{"cell_id":"46","yield_time_ms":30000,"max_tokens":12000}',
        },
      },
    });
    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'function_call_output',
          call_id: 'call-wait-1',
          output: 'Script completed',
        },
      },
    });

    const emitted = publishedMessages(published.events);
    expect(emitted.map((message) => message.type)).toEqual([
      'bash-tool-use',
      'tool-result',
      'wait-tool-use',
      'tool-result',
    ]);
    expect(emitted[0]).toMatchObject({
      toolId: 'codex-code-mode:call-exec-1:0',
      command: 'pwd',
    });
    expect(emitted[1]).toMatchObject({
      toolId: 'codex-code-mode:call-exec-1:0',
      content: { items: [{ type: 'input_text', text: '1' }] },
      isError: false,
    });
    expect(emitted[2]).toMatchObject({
      toolId: 'call-wait-1',
      executionId: '46',
      yieldTimeMs: 30000,
      maxTokens: 12000,
    });
    expect(emitted[3]).toMatchObject({
      toolId: 'call-wait-1',
      content: { raw: 'Script completed' },
      isError: false,
    });
  });

  it('streams terminal subagent communications without another management call', async () => {
    const nativePath = path.join(tmpDir, 'live-subagent-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agent_message',
          id: 'worker-final-1',
          author: '/root/reviewer',
          recipient: '/root',
          content: [{
            type: 'input_text',
            text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\nReview complete',
          }],
        },
      },
    });

    const emitted = publishedMessages(published.events);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'codex-subagent-tool-use',
      action: 'agent_status',
      details: {
        target: '/root/reviewer',
        agentStates: { '/root/reviewer': { status: 'completed', message: 'Review complete' } },
      },
    });
  });

  it('clears unmatched raw Code Mode calls at an automatic goal turn boundary', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId }, options) => {
        await options.prepareDelivery();
        return { turnId: expectedTurnId };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Keep the session active' },
      nativePath: null,
      operation: published.operation,
    }));

    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'goal-turn',
        item: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call-stale',
          arguments: '{"cell_id":"46"}',
        },
      },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });
    expect(provider.isRunning('thread-1')).toBe(true);
    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'goal-turn',
        item: {
          type: 'function_call_output',
          call_id: 'call-stale',
          output: 'late output',
        },
      },
    });

    expect(publishedMessages(published.events).map((message) => message.type)).toEqual([
      'wait-tool-use',
    ]);
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'goal-turn',
        goal: makeGoal('thread-1', 'Keep the session active', 'complete'),
      },
    });
    await finished;
  });

  it('sets a new native goal and waits for its automatic turn without starting a user turn', async () => {
    const nativePath = path.join(tmpDir, 'goal-thread.jsonl');
    const calls = [];
    let fake;
    fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      getThreadGoal: async () => {
        calls.push('get');
        return { goal: null };
      },
      setThreadGoal: async (threadId, params) => {
        calls.push(`goal:${params.objective}`);
        await fs.writeFile(nativePath, '{}\n');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: {
            threadId,
            turn: makeTurn({ id: 'goal-turn', status: 'inProgress', completedAt: null, durationMs: null }),
          },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });

    await provider.startSession(makeRequest({ codexGoalCommand: { kind: 'set', objective: 'Ship the feature' } }));

    expect(fake.setThreadGoal).toHaveBeenCalledWith('thread-1', {
      objective: 'Ship the feature',
      status: 'active',
    });
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(calls).toEqual(['get', 'goal:Ship the feature']);
  });

  it('injects carried context before setting a seeded goal', async () => {
    const nativePath = path.join(tmpDir, 'seeded-goal-thread.jsonl');
    const calls = [];
    let fake;
    fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      injectThreadItems: async (params) => { calls.push(['inject', params]); },
      getThreadGoal: async () => { calls.push(['get']); return { goal: null }; },
      setThreadGoal: async (threadId, params) => {
        calls.push(['set', params.objective]);
        await fs.writeFile(nativePath, '{}\n');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });

    await provider.startSession(makeRequest({
      command: 'Ship seeded work',
      codexGoalCommand: { kind: 'set', objective: 'Ship seeded work' },
      codexSeedContext: '<carried-context>Earlier work</carried-context>',
    }));

    expect(calls).toEqual([
      ['inject', {
        threadId: 'thread-1',
        items: [{
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: '<carried-context>Earlier work</carried-context>' }],
        }],
      }],
      ['get'],
      ['set', 'Ship seeded work'],
    ]);
  });

  it('rejects replacing an unfinished goal unless replacement is explicit', async () => {
    for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited']) {
      const fake = new FakeClient({
        getThreadGoal: async (threadId) => ({ goal: makeGoal(threadId, 'Existing work', status) }),
      });
      const provider = createRuntime({ createClient: () => fake });
      const published = collectOperation();
      await provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        codexGoalCommand: { kind: 'set', objective: 'Replacement work' },
        nativePath: null,
        operation: published.operation,
      }));

      expect(fake.setThreadGoal).not.toHaveBeenCalled();
      expect(fake.clearThreadGoal).not.toHaveBeenCalled();
      expect(publishedMessages(published.events).at(-1)?.content).toContain(
        '/goal replace <objective>',
      );
      expect(provider.isRunning('thread-1')).toBe(status === 'active');
    }
  });

  it('allows replacing a completed goal', async () => {
    const calls = [];
    let fake;
    fake = new FakeClient({
      getThreadGoal: async (threadId) => ({ goal: makeGoal(threadId, 'Finished work', 'complete') }),
      clearThreadGoal: async (threadId) => {
        calls.push(`clear:${threadId}`);
        return { cleared: true };
      },
      setThreadGoal: async (threadId, params) => {
        calls.push(`goal:${params.objective}`);
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'New work' },
      nativePath: null,
    }));

    expect(calls).toEqual(['clear:thread-1', 'goal:New work']);
    expect(fake.startTurn).not.toHaveBeenCalled();
  });

  it('replaces an unfinished goal only through the explicit replacement command', async () => {
    const calls = [];
    let fake;
    fake = new FakeClient({
      getThreadGoal: async (threadId) => ({ goal: makeGoal(threadId, 'Existing work', 'blocked') }),
      clearThreadGoal: async () => {
        calls.push('clear');
        return { cleared: true };
      },
      setThreadGoal: async (threadId, params) => {
        calls.push('set');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'replacement-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Confirmed replacement' },
      nativePath: null,
    }));

    expect(calls).toEqual(['clear', 'set']);
    expect(fake.setThreadGoal).toHaveBeenCalledWith('thread-1', {
      objective: 'Confirmed replacement',
      status: 'active',
    });
  });

  it('restores and reconciles the previous goal when replacement set fails', async () => {
    const previous = { ...makeGoal('thread-1', 'Existing work', 'paused'), tokenBudget: 50_000 };
    const calls = [];
    const fake = new FakeClient({
      getThreadGoal: async () => ({ goal: previous }),
      clearThreadGoal: async () => { calls.push('clear'); return { cleared: true }; },
      setThreadGoal: async (threadId, params) => {
        calls.push(params);
        if (params.objective === 'Replacement work') throw new Error('replacement rejected');
        return { goal: { ...previous, threadId, ...params } };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
      operation: published.operation,
    }));

    expect(calls).toEqual([
      'clear',
      { objective: 'Replacement work', status: 'active' },
      { objective: 'Existing work', status: 'paused', tokenBudget: 50_000 },
    ]);
    expect(fake.getThreadGoal).toHaveBeenCalledTimes(3);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(publishedMessages(published.events).at(-1)?.content).toContain('replacement rejected');
  });

  it('keeps an active restored goal alive when replacement set fails', async () => {
    const previous = makeGoal('thread-1', 'Existing work', 'active');
    const fake = new FakeClient({
      getThreadGoal: async () => ({ goal: previous }),
      clearThreadGoal: async () => ({ cleared: true }),
      setThreadGoal: async (threadId, params) => {
        if (params.objective === 'Replacement work') throw new Error('replacement rejected');
        return { goal: { ...previous, threadId, ...params } };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
    }));

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(fake.setThreadGoal).toHaveBeenLastCalledWith('thread-1', {
      objective: 'Existing work',
      status: 'active',
      tokenBudget: null,
    });

    fake.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 'thread-1' },
    });
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('ignores a delayed replacement clear after the replacement goal starts', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async (threadId) => ({ goal: makeGoal(threadId, 'Existing work', 'blocked') }),
      clearThreadGoal: async () => ({ cleared: true }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'replacement-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
    }));
    fake.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 'thread-1' },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'replacement-turn' }) },
    });

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('releases clear suppression immediately when replacement clear does not commit', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async (threadId) => ({ goal: makeGoal(threadId, 'Existing work', 'blocked') }),
      clearThreadGoal: async () => ({ cleared: false }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'replacement-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
      operation: published.operation,
    }));
    fake.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 'thread-1' },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'replacement-turn' }) },
    });
    await finished;

    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('restores an active goal when replacement clear commits but its response is lost', async () => {
    const previous = makeGoal('thread-1', 'Existing work', 'active');
    let goal = previous;
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal }),
      clearThreadGoal: async () => {
        goal = null;
        fake.emit('notification', {
          method: 'thread/goal/cleared',
          params: { threadId: 'thread-1' },
        });
        throw new Error('clear response lost');
      },
      setThreadGoal: async (threadId, params) => {
        goal = { ...previous, threadId, ...params };
        return { goal };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
    }));

    expect(fake.getThreadGoal).toHaveBeenCalledTimes(3);
    expect(fake.setThreadGoal).toHaveBeenCalledTimes(1);
    expect(fake.setThreadGoal).toHaveBeenCalledWith('thread-1', {
      objective: 'Existing work',
      status: 'active',
      tokenBudget: null,
    });
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    goal = null;
    fake.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 'thread-1' },
    });
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('finishes cleanly when replacement and rollback both fail', async () => {
    const previous = makeGoal('thread-1', 'Existing work', 'blocked');
    let getCalls = 0;
    const fake = new FakeClient({
      getThreadGoal: async () => ({ goal: getCalls++ === 0 ? previous : null }),
      clearThreadGoal: async () => ({ cleared: true }),
      setThreadGoal: async () => { throw new Error('goal set unavailable'); },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
    }));

    expect(fake.setThreadGoal).toHaveBeenCalledTimes(2);
    expect(fake.getThreadGoal).toHaveBeenCalledTimes(3);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('reports the current Codex goal without starting a turn', async () => {
    const fake = new FakeClient({
      getThreadGoal: async (threadId) => ({
        goal: makeGoal(threadId, 'Ship the feature'),
      }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal',
      codexGoalCommand: { kind: 'status' },
      nativePath: null,
      operation: published.operation,
    }));

    expect(fake.getThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(publishedMessages(published.events).map((message) => message.content)).toEqual([
      'Goal\nStatus: active\nObjective: Ship the feature\nTime used: 0s\nTokens used: 0\n\nCommands: /goal edit <objective>, /goal pause, /goal clear',
    ]);
  });

  it('clears the current Codex goal without starting a turn', async () => {
    const fake = new FakeClient({
      clearThreadGoal: async () => ({ cleared: true }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal clear',
      codexGoalCommand: { kind: 'clear' },
      nativePath: null,
      operation: published.operation,
    }));
    await finished;

    expect(fake.clearThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(publishedMessages(published.events).map((message) => message.content)).toEqual([
      'Codex goal cleared.',
    ]);
  });

  it('pauses the current Codex goal without starting a turn', async () => {
    const fake = new FakeClient({
      setThreadGoalStatus: async (threadId, status) => ({ goal: makeGoal(threadId, 'Ship the feature', status) }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal pause',
      codexGoalCommand: { kind: 'pause' },
      nativePath: null,
      operation: published.operation,
    }));
    await finished;

    expect(fake.setThreadGoalStatus).toHaveBeenCalledWith('thread-1', 'paused');
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(publishedMessages(published.events).map((message) => message.content)).toEqual([
      'Codex goal paused.\nObjective: Ship the feature\nUsage: time 0s, tokens 0.',
    ]);
  });

  it('resumes a Codex goal through the native continuation turn', async () => {
    let statusCalled;
    const statusReady = new Promise((resolve) => {
      statusCalled = resolve;
    });
    const fake = new FakeClient({
      setThreadGoalStatus: async (threadId, status) => {
        statusCalled();
        return { goal: makeGoal(threadId, 'Ship the feature', status) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    const running = provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal resume',
      codexGoalCommand: { kind: 'resume' },
      nativePath: null,
    }));
    await statusReady;
    fake.emit('notification', {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: makeTurn({ id: 'goal-turn', status: 'inProgress', completedAt: null, durationMs: null }),
      },
    });
    await running;

    expect(fake.setThreadGoalStatus).toHaveBeenCalledWith('thread-1', 'active');
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(true);
  });

  it('finishes without waiting when resume returns a terminal goal status', async () => {
    const fake = new FakeClient({
      setThreadGoalStatus: async (threadId) => ({
        goal: makeGoal(threadId, 'Ship the feature', 'budgetLimited'),
      }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal resume',
      codexGoalCommand: { kind: 'resume' },
      nativePath: null,
      operation: published.operation,
    }));
    await finished;

    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(publishedMessages(published.events).at(-1)?.content).toContain('Codex goal updated.');
    expect(publishedMessages(published.events).at(-1)?.content).toContain('Ship the feature');
  });

  it('replays continuation notifications received during thread resume', async () => {
    let fake;
    fake = new FakeClient({
      resumeThread: async () => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: null,
            goal: makeGoal('thread-1', 'Ship the feature', 'active'),
          },
        }));
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'early-goal-turn', status: 'inProgress' }) },
        }));
        await Promise.resolve();
        return { thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
      },
      setThreadGoalStatus: async (threadId, status) => ({ goal: makeGoal(threadId, 'Ship the feature', status) }),
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'resume' },
      nativePath: null,
    }));

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('synchronizes a split-chunk active goal before gap pause and clear controls', async () => {
    for (const control of ['pause', 'clear']) {
      const calls = [];
      const fake = new FakeClient({
        resumeThread: async () => {
          calls.push('resume');
          return { thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
        },
        getThreadGoal: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          calls.push('get');
          return { goal: makeGoal('thread-1', 'Ship the feature', 'active') };
        },
        setThreadGoalStatus: async (threadId, status) => {
          calls.push('pause');
          return { goal: makeGoal(threadId, 'Ship the feature', status) };
        },
        clearThreadGoal: async () => {
          calls.push('clear');
          return { cleared: false };
        },
      });
      const provider = createRuntime({ createClient: () => fake });

      await provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        command: `/goal ${control}`,
        codexGoalCommand: { kind: control },
        nativePath: null,
      }));

      expect(calls).toEqual(['resume', 'get', control]);
      expect(provider.isRunning('thread-1')).toBe(false);
      expect(fake.shutdown).not.toHaveBeenCalled();
    }
  });

  it('keeps a restored active turn through a pause response and its turn boundary', async () => {
    let fake;
    fake = new FakeClient({
      resumeThread: async () => {
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'automatic-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'active'),
          },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
        });
        return { thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
      },
      getThreadGoal: async () => ({ goal: makeGoal('thread-1', 'Ship the feature', 'active') }),
      setThreadGoalStatus: async (threadId, status) => ({
        goal: makeGoal(threadId, 'Ship the feature', status),
      }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'pause' },
      nativePath: null,
      operation: published.operation,
    }));

    expect(publishedMessages(published.events).at(-1)?.content).toContain('Codex goal paused.');
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'automatic-turn',
        goal: makeGoal('thread-1', 'Ship the feature', 'paused'),
      },
    });
    expect(provider.isRunning('thread-1')).toBe(true);
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn' }) },
    });
    await finished;
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('keeps a restored active turn through a clear response and its turn boundary', async () => {
    let fake;
    fake = new FakeClient({
      resumeThread: async () => {
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'automatic-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'active'),
          },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
        });
        return { thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
      },
      getThreadGoal: async () => ({ goal: makeGoal('thread-1', 'Ship the feature', 'active') }),
      clearThreadGoal: async () => ({ cleared: true }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'clear' },
      nativePath: null,
      operation: published.operation,
    }));

    expect(publishedMessages(published.events).at(-1)?.content).toBe('Codex goal cleared.');
    expect(provider.isRunning('thread-1')).toBe(true);
    fake.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 'thread-1' },
    });
    expect(provider.isRunning('thread-1')).toBe(true);
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn' }) },
    });
    await finished;
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('keeps a resumed goal turn after buffered terminal replay defers the prior finish', async () => {
    let fake;
    fake = new FakeClient({
      resumeThread: async () => {
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'automatic-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'active'),
          },
        });
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
        });
        fake.emit('notification', {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn' }) },
        });
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'automatic-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'complete'),
          },
        });
        return { thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
      },
      setThreadGoalStatus: async (threadId) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'resumed-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, 'Ship the feature', 'active') };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'resume' },
      nativePath: null,
    }));

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('routes approvals that arrive after resume through the synchronized goal session', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => {
        setTimeout(() => {
          fake.emit('notification', {
            method: 'thread/goal/updated',
            params: {
              threadId: 'thread-1',
              turnId: 'automatic-turn',
              goal: makeGoal('thread-1', 'Ship the feature', 'active'),
            },
          });
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
          });
          fake.emit('serverRequest', {
            id: 77,
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-1', turnId: 'automatic-turn', itemId: 'cmd-1', command: 'bun test' },
          });
        }, 0);
        return { goal: makeGoal('thread-1', 'Ship the feature', 'active') };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Continue after approval',
      nativePath: null,
      operation: published.operation,
    }));

    const request = permissionEvents(published.events).find(
      (event) => event.lifecycle.kind === 'requested',
    );
    expect(request).toBeDefined();
    expect(fake.respond).not.toHaveBeenCalled();
    expect(fake.getThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(fake.steerTurn).toHaveBeenCalledWith(expect.objectContaining({
      expectedTurnId: 'automatic-turn',
    }));
    await request.decision.respond({ allow: true });
    expect(fake.respond).toHaveBeenCalledWith(77, { decision: 'accept' });
  });

  it('waits for a restored active goal turn emitted after resume before steering ordinary input', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => {
        setTimeout(() => {
          fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'automatic-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'active'),
          },
          });
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
          });
        }, 0);
        return { goal: makeGoal('thread-1', 'Ship the feature', 'active') };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Prioritize the restart failure',
      clientMessageId: 'restart-message',
      nativePath: null,
    }));

    expect(fake.steerTurn).toHaveBeenCalledTimes(1);
    expect(fake.getThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(fake.steerTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      expectedTurnId: 'automatic-turn',
      clientUserMessageId: 'restart-message',
      input: [{ type: 'text', text: 'Prioritize the restart failure', text_elements: [] }],
    });
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(true);
  });

  it('keeps status read-only when resume restores an active goal continuation', async () => {
    let fake;
    fake = new FakeClient({
      resumeThread: async () => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'automatic-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'active'),
          },
        }));
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
        }));
        await Promise.resolve();
        return { thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
      },
      getThreadGoal: async () => ({ goal: makeGoal('thread-1', 'Ship the feature', 'active') }),
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'status' },
      nativePath: null,
    }));

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(fake.steerTurn).not.toHaveBeenCalled();
    expect(fake.interruptTurn).not.toHaveBeenCalled();
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('applies a restored goal snapshot before replaying newer buffered goal notifications', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => {
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'completed-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'complete'),
          },
        });
        return { goal: makeGoal('thread-1', 'Ship the feature', 'active') };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'status' },
      nativePath: null,
      operation: published.operation,
    }));

    expect(publishedMessages(published.events).at(-1)?.content).toContain('Status: complete');
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(fake.steerTurn).not.toHaveBeenCalled();
  });

  it('delivers accepted restart input after buffered notifications finish the restored turn', async () => {
    let fake;
    fake = new FakeClient({
      resumeThread: async () => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'automatic-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'active'),
          },
        }));
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
        }));
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn' }) },
        }));
        queueMicrotask(() => fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'automatic-turn',
            goal: makeGoal('thread-1', 'Ship the feature', 'complete'),
          },
        }));
        await Promise.resolve();
        return { thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Do not dispatch after terminal replay',
      nativePath: null,
    }));

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Do not dispatch after terminal replay', text_elements: [] }],
    }));
    expect(fake.steerTurn).not.toHaveBeenCalled();
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it.each(['finish', 'abort', 'exit'])(
    'settles goal-turn waiters immediately when sessions terminate via %s',
    async (termination) => {
      let setCalled;
      const ready = new Promise((resolve) => { setCalled = resolve; });
      const fake = new FakeClient({
        getThreadGoal: async () => ({ goal: null }),
        setThreadGoal: async (threadId, params) => {
          setCalled();
          return { goal: makeGoal(threadId, params.objective) };
        },
      });
      const provider = createRuntime({ createClient: () => fake });
      const published = collectOperation();
      const running = provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        codexGoalCommand: { kind: 'set', objective: `Wait for ${termination}` },
        nativePath: null,
        operation: published.operation,
      }));
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (termination === 'finish') {
        fake.emit('notification', { method: 'thread/goal/cleared', params: { threadId: 'thread-1' } });
      } else if (termination === 'abort') {
        await expect(provider.abort('thread-1')).resolves.toBe(true);
      } else {
        fake.emit('exit', 7);
      }
      await running;

      expect(provider.isRunning('thread-1')).toBe(false);
      expect(publishedMessages(published.events).some(
        (message) => String(message.content).includes('timed out waiting'),
      )).toBe(false);
    },
  );

  it('edits a paused goal while preserving its status and token budget', async () => {
    const existing = {
      ...makeGoal('thread-1', 'Old objective', 'paused'),
      tokenBudget: 80_000,
      tokensUsed: 12_500,
      timeUsedSeconds: 60,
    };
    const fake = new FakeClient({
      getThreadGoal: async () => ({ goal: existing }),
      setThreadGoal: async (threadId, params) => ({ goal: { ...existing, threadId, ...params } }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal edit Better objective',
      codexGoalCommand: { kind: 'edit', objective: 'Better objective' },
      nativePath: null,
      operation: published.operation,
    }));
    await finished;

    expect(fake.setThreadGoal).toHaveBeenCalledWith('thread-1', {
      objective: 'Better objective',
      status: 'paused',
      tokenBudget: 80_000,
    });
    expect(fake.startTurn).not.toHaveBeenCalled();
  });

  it('uses the returned goal status when an edited exhausted goal cannot continue', async () => {
    const current = makeGoal('thread-1', 'Old objective', 'complete');
    const fake = new FakeClient({
      getThreadGoal: async () => ({ goal: current }),
      setThreadGoal: async (threadId, params) => ({
        goal: { ...current, threadId, objective: params.objective, status: 'budgetLimited' },
      }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'edit', objective: 'Better objective' },
      nativePath: null,
      operation: published.operation,
    }));
    await finished;

    expect(fake.setThreadGoal).toHaveBeenCalledWith('thread-1', {
      objective: 'Better objective',
      status: 'active',
      tokenBudget: null,
    });
    expect(provider.isRunning('thread-1')).toBe(false);
  });

  it('shows actionable usage for a bare goal edit', async () => {
    const fake = new FakeClient();
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal edit',
      codexGoalCommand: { kind: 'edit', objective: null },
      nativePath: null,
      operation: published.operation,
    }));
    await finished;

    expect(publishedMessages(published.events).at(-1)?.content).toBe(
      'Usage: /goal edit <objective>',
    );
    expect(fake.getThreadGoal).toHaveBeenCalledTimes(1);
  });

  it('keeps one app-server session across automatic goal turns until completion', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn-1', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Finish all rounds' },
      nativePath: null,
      operation: published.operation,
    }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn-1' }) },
    });
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    fake.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn-2', status: 'inProgress' }) },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn-2' }) },
    });
    expect(provider.isRunning('thread-1')).toBe(true);
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'goal-turn-2',
        goal: makeGoal('thread-1', 'Finish all rounds', 'complete'),
      },
    });
    await finished;

    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(fake.startTurn).not.toHaveBeenCalled();
  });

  it('steers ordinary active-goal input through the existing client and turn', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Prioritize the failing test',
      clientMessageId: 'message-steer',
      nativePath: null,
    }))).resolves.toBe(true);

    expect(fake.steerTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      expectedTurnId: 'goal-turn',
      clientUserMessageId: 'message-steer',
      input: [{ type: 'text', text: 'Prioritize the failing test', text_elements: [] }],
    });
    expect(fake.resumeThread).toHaveBeenCalledTimes(1);
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('strictly steers the current regular turn inside a managed goal', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async (_params, options) => {
        await options.prepareDelivery();
        return { turnId: 'goal-turn' };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    const prepareDelivery = mock(async () => undefined);

    await expect(provider.steer({
      chatId: 'chat-1',
      projectPath: '/repo',
      agentSessionId: 'thread-1',
      nativeSession: null,
      target: provider.captureSteerTarget('thread-1'),
      input: 'Prioritize the failing test',
      clientMessageId: 'message-strict-steer',
      prepareDelivery,
    })).resolves.toEqual({ kind: 'accepted' });

    expect(prepareDelivery).toHaveBeenCalledOnce();
    expect(fake.steerTurn).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      expectedTurnId: 'goal-turn',
      clientUserMessageId: 'message-strict-steer',
      input: [{ type: 'text', text: 'Prioritize the failing test', text_elements: [] }],
    }, expect.objectContaining({ prepareDelivery }));
    expect(fake.startTurn).not.toHaveBeenCalled();
  });

  it('reconciles goal control through the delivered payload and native history loader', async () => {
    const content = 'Preserve goal control & literal markup <exactly>';
    const nativePath = path.join(tmpDir, 'goal-control.jsonl');
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId, input }) => {
        const deliveredText = input.find((item) => item.type === 'text')?.text;
        await fs.writeFile(nativePath, `${JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-06-01T00:00:00.100Z',
          payload: { type: 'user_message', message: deliveredText },
        })}\n`);
        return { turnId: expectedTurnId };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: content,
      clientMessageId: 'message-steer',
      nativePath,
    }), async (handoff) => {
      handoff.validate();
      handoff.commit();
    })).resolves.toBe(true);

    // The goal-control steer delivers its text to the running goal client and
    // the client persists it to native history.
    expect(await loadCodexChatMessages(nativePath)).toMatchObject([
      { type: 'user-message', content },
    ]);
  });

  it('routes a running-chat queue submission into the active goal client', async () => {
    let registered = false;
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId }) => {
        expect(registered).toBe(true);
        return { turnId: expectedTurnId };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    const queue = new ChatExecutionCoordinator(
      tmpDir,
      {
        runAgentTurn: async () => { throw new Error('must use active delivery'); },
        submitGoalControl: (_chatId, command, options, beforeDelivery) => provider.submitGoalControl(makeRequest({
          ...options,
          agentSessionId: 'thread-1',
          command,
          nativePath: null,
        }), beforeDelivery),
        abortSession: async () => false,
        isChatRunning: () => provider.isRunning('thread-1'),
      },
      {
        admitInput: async () => {
          registered = true;
          return { inserted: true };
        },
        admitQueuedInput: () => ({ inserted: true }),
        discardPreparedInput: () => {},
      },
      () => ({
        model: 'gpt-5.4-codex',
        permissionMode: 'default',
        thinkingMode: 'medium',
        claudeThinkingMode: 'off',
        ampAgentMode: 'default',
      }),
      () => true,
      new InMemoryChatExecutionControlRepository('server-instance-test'),
    );

    const result = await queue.deliverGoalControlInput('chat-1', 'Steer from the queue', {
      clientRequestId: 'request-queue',
      clientMessageId: 'message-queue',
      turnId: 'turn-queue',
    });

    expect(result).toBe(true);
    expect((await queue.readChatExecutionControl('chat-1')).entries).toEqual([]);
    expect(fake.steerTurn).toHaveBeenCalledWith(expect.objectContaining({
      expectedTurnId: 'goal-turn',
      clientUserMessageId: 'message-queue',
    }));
    expect(fake.resumeThread).toHaveBeenCalledTimes(1);
  });

  it('reports accepted active goal RPC failures through the queue delivery contract', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      setThreadGoalStatus: async () => { throw new Error('goal status unavailable'); },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    const published = collectOperation('chat-1', 'run-goal-failure');
    const queue = createActiveGoalQueue(
      provider,
      { kind: 'pause' },
      published.operation,
    );

    await expect(queue.deliverGoalControlInput('chat-1', '/goal pause', {
      clientRequestId: 'request-goal-failure',
      clientMessageId: 'message-goal-failure',
      turnId: 'turn-goal-failure',
    })).rejects.toMatchObject({
      deliveryAccepted: true,
      retryable: false,
      cause: expect.objectContaining({ message: 'goal status unavailable' }),
    });

    expect(publishedMessages(published.events).at(-1)?.content).toBe(
      'Codex error: goal status unavailable',
    );
  });

  it('reports accepted active goal cancellation through the queue delivery contract', async () => {
    let statusRequested;
    const statusRequest = new Promise((resolve) => { statusRequested = resolve; });
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      setThreadGoalStatus: async (threadId) => {
        statusRequested();
        return { goal: makeGoal(threadId, 'Long-running work', 'active') };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });
    const queue = createActiveGoalQueue(provider, { kind: 'resume' });

    const delivery = queue.deliverGoalControlInput('chat-1', '/goal resume', {
      clientRequestId: 'request-goal-cancelled',
      clientMessageId: 'message-goal-cancelled',
      turnId: 'turn-goal-cancelled',
    });
    await statusRequest;
    await Promise.resolve();
    await provider.abort('thread-1');

    await expect(delivery).rejects.toMatchObject({
      deliveryAccepted: true,
      retryable: false,
      cause: expect.any(Error),
    });
  });

  it('declines goal control without accepting its user row after the Codex session ends', async () => {
    const nativePath = path.join(tmpDir, 'ended-before-acceptance.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await finished;
    let accepted = false;

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'too late',
      nativePath: null,
    }), async () => { accepted = true; })).resolves.toBe(false);

    expect(accepted).toBe(false);
    expect(fake.steerTurn).not.toHaveBeenCalled();
  });

  it('keeps compact and other unmanaged turns on the persisted queue path', async () => {
    const fake = new FakeClient();
    const provider = createRuntime({ createClient: () => fake });
    await provider.compact(makeRequest({ agentSessionId: 'thread-1', nativePath: null }));
    let accepted = false;

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'queue after compact',
      nativePath: null,
    }), async () => { accepted = true; })).resolves.toBe(false);

    expect(accepted).toBe(false);
    expect(fake.steerTurn).not.toHaveBeenCalled();
    expect(fake.startTurn).not.toHaveBeenCalled();
  });

  it('falls back to turn/start on the same client when a turn-boundary steer loses the race', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async () => { throw new Error('no active turn to steer'); },
      startTurn: async () => ({ turn: makeTurn({ id: 'priority-turn', status: 'inProgress' }) }),
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Take this next',
      nativePath: null,
    }));

    expect(fake.steerTurn).toHaveBeenCalledTimes(1);
    expect(fake.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Take this next', text_elements: [] }],
    }));
    expect(fake.resumeThread).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);
  });

  it('steers the automatic continuation once when it wins the turn/start boundary race', async () => {
    const steeredTurnIds = [];
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'stale-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId }) => {
        steeredTurnIds.push(expectedTurnId);
        if (expectedTurnId === 'stale-turn') throw new Error('no active turn to steer');
        return { turnId: expectedTurnId };
      },
      startTurn: async () => {
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
        });
        throw new Error('active turn already in progress');
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Do this exactly once',
      nativePath: null,
    }));

    expect(steeredTurnIds).toEqual(['stale-turn', 'automatic-turn']);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(fake.steerTurn.mock.calls[1][0].input).toEqual([
      { type: 'text', text: 'Do this exactly once', text_elements: [] },
    ]);
  });

  it('adopts the server-reported rollover turn and retries steering exactly once', async () => {
    const steeredTurnIds = [];
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'old-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId }) => {
        steeredTurnIds.push(expectedTurnId);
        if (expectedTurnId === 'old-turn') {
          throw new Error('expected active turn id `old-turn` but found `new-turn`');
        }
        return { turnId: expectedTurnId };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Steer across rollover',
      nativePath: null,
    }))).resolves.toBe(true);

    expect(steeredTurnIds).toEqual(['old-turn', 'new-turn']);
    expect(fake.startTurn).not.toHaveBeenCalled();
  });

  it('retries a mismatch once when steer observes an ordinary turn boundary', async () => {
    const steeredTurnIds = [];
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'old-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId }) => {
        steeredTurnIds.push(expectedTurnId);
        if (expectedTurnId === 'old-turn') {
          fake.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: makeTurn({ id: 'old-turn' }) },
          });
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: makeTurn({ id: 'new-turn', status: 'inProgress' }) },
          });
          throw new Error('expected active turn id `old-turn` but found `new-turn`');
        }
        return { turnId: expectedTurnId };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Deliver across the boundary',
      nativePath: null,
    }))).resolves.toBe(true);

    expect(steeredTurnIds).toEqual(['old-turn', 'new-turn']);
    expect(fake.steerTurn.mock.calls.map(([params]) => params.input)).toEqual([
      [{ type: 'text', text: 'Deliver across the boundary', text_elements: [] }],
      [{ type: 'text', text: 'Deliver across the boundary', text_elements: [] }],
    ]);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('retries a no-active error once when a continuation starts at the turn boundary', async () => {
    const steeredTurnIds = [];
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'old-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId }) => {
        steeredTurnIds.push(expectedTurnId);
        if (expectedTurnId === 'old-turn') {
          fake.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: makeTurn({ id: 'old-turn' }) },
          });
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: makeTurn({ id: 'new-turn', status: 'inProgress' }) },
          });
          throw new Error('no active turn to steer');
        }
        return { turnId: expectedTurnId };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Deliver to the continuation',
      nativePath: null,
    }))).resolves.toBe(true);

    expect(steeredTurnIds).toEqual(['old-turn', 'new-turn']);
    expect(fake.steerTurn.mock.calls.map(([params]) => params.input)).toEqual([
      [{ type: 'text', text: 'Deliver to the continuation', text_elements: [] }],
      [{ type: 'text', text: 'Deliver to the continuation', text_elements: [] }],
    ]);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('rejects accepted input when a nested capacity retry advances two generations', async () => {
    const controlledDelay = createControlledDelay();
    const retryStarted = createDeferred();
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'old-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async () => {
        fake.emit('notification', {
          method: 'thread/goal/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'old-turn',
            goal: makeGoal('thread-1', 'Long-running work', 'blocked'),
          },
        });
        emitCapacityFailure(fake, 'old-turn');
        throw new Error('expected active turn id `old-turn` but found `capacity-turn`');
      },
      setThreadGoalStatus: async (threadId, status) => {
        const goal = makeGoal(threadId, 'Long-running work', status);
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'retry-turn', status: 'inProgress' }) },
        });
        retryStarted.resolve();
        return { goal };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      capacityRetryDelaysMs: [25],
      capacityRetryDelay: controlledDelay.wait,
    });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Do not drop this input',
      nativePath: null,
    }))).rejects.toThrow('expected active turn id `old-turn` but found `capacity-turn`');
    await expect(controlledDelay.started).resolves.toBe(25);
    expect(fake.steerTurn).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);

    controlledDelay.release();
    await retryStarted.promise;
    expect(fake.setThreadGoalStatus).toHaveBeenCalledWith('thread-1', 'active');
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('retains accepted input across non-steerable goal turns and delivers it to the next turn', async () => {
    for (const turnKind of ['review', 'compact']) {
      const steeredTurnIds = [];
      let rejectedNonSteerable;
      const nonSteerableRejected = new Promise((resolve) => { rejectedNonSteerable = resolve; });
      let fake;
      fake = new FakeClient({
        getThreadGoal: async () => ({ goal: null }),
        setThreadGoal: async (threadId, params) => {
          queueMicrotask(() => fake.emit('notification', {
            method: 'turn/started',
            params: { threadId, turn: makeTurn({ id: 'old-turn', status: 'inProgress' }) },
          }));
          return { goal: makeGoal(threadId, params.objective) };
        },
        steerTurn: async ({ expectedTurnId }) => {
          steeredTurnIds.push(expectedTurnId);
          if (expectedTurnId === 'old-turn') {
            throw new Error(`expected active turn id \`old-turn\` but found \`${turnKind}-turn\``);
          }
          if (expectedTurnId === `${turnKind}-turn`) {
            rejectedNonSteerable();
            throw new CodexAppServerRpcError(
              `cannot steer a ${turnKind} turn`,
              -32600,
              {
                message: `cannot steer a ${turnKind} turn`,
                codexErrorInfo: { activeTurnNotSteerable: { turnKind } },
                additionalDetails: null,
              },
            );
          }
          return { turnId: expectedTurnId };
        },
      });
      const provider = createRuntime({ createClient: () => fake });
      await provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
        nativePath: null,
      }));
      let accepted = false;

      const delivery = provider.submitGoalControl(makeRequest({
        agentSessionId: 'thread-1',
        command: `Deliver after ${turnKind}`,
        nativePath: null,
      }), async (handoff) => {
        accepted = true;
        handoff.validate();
        handoff.commit();
      });
      await nonSteerableRejected;
      expect(accepted).toBe(true);
      fake.emit('notification', {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: makeTurn({ id: `${turnKind}-turn` }) },
      });
      fake.emit('notification', {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: makeTurn({ id: 'next-turn', status: 'inProgress' }) },
      });

      await expect(delivery).resolves.toBe(true);
      expect(steeredTurnIds).toEqual(['old-turn', `${turnKind}-turn`, 'next-turn']);
      expect(fake.startTurn).not.toHaveBeenCalled();
      expect(provider.isRunning('thread-1')).toBe(true);
    }
  });

  it('falls back to turn start when a mismatch retry finds no active turn', async () => {
    const steeredTurnIds = [];
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'old-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId }) => {
        steeredTurnIds.push(expectedTurnId);
        if (expectedTurnId === 'old-turn') {
          throw new Error('expected active turn id `old-turn` but found `boundary-turn`');
        }
        throw new Error('no active turn to steer');
      },
      startTurn: async () => ({ turn: makeTurn({ id: 'user-turn', status: 'inProgress' }) }),
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Start after the boundary',
      nativePath: null,
    }))).resolves.toBe(true);

    expect(steeredTurnIds).toEqual(['old-turn', 'boundary-turn']);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
  });

  it('adopts a newly started turn after a mismatch retry finds no active turn', async () => {
    const steeredTurnIds = [];
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'old-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      steerTurn: async ({ expectedTurnId }) => {
        steeredTurnIds.push(expectedTurnId);
        if (expectedTurnId === 'old-turn') {
          throw new Error('expected active turn id `old-turn` but found `boundary-turn`');
        }
        if (expectedTurnId === 'boundary-turn') {
          fake.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: makeTurn({ id: 'fresh-turn', status: 'inProgress' }) },
          });
          throw new Error('no active turn to steer');
        }
        return { turnId: expectedTurnId };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Steer the fresh turn',
      nativePath: null,
    }))).resolves.toBe(true);

    expect(steeredTurnIds).toEqual(['old-turn', 'boundary-turn', 'fresh-turn']);
    expect(fake.startTurn).not.toHaveBeenCalled();
  });

  it('keeps the predecessor publisher when persistence fails with a terminal finish pending', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const predecessor = collectOperation('chat-1', 'turn-a');
    const successor = collectOperation('chat-1', 'turn-b');
    const failed = predecessor.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'failed',
    );
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
      operation: predecessor.operation,
    }));

    const first = provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'First input',
      nativePath: null,
      operation: successor.operation,
    }), async () => {
      fake.emit('notification', {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'goal-turn',
          willRetry: false,
          error: { message: 'terminal failure', codexErrorInfo: null, additionalDetails: null },
        },
      });
      throw new Error('registration failed');
    });
    await expect(first).rejects.toThrow('registration failed');
    await expect(failed).resolves.toMatchObject({
      runId: 'turn-a',
      error: { message: 'terminal failure' },
    });
    expect(terminalEvents(successor.events)).toEqual([]);
    let accepted = false;
    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Must fall back',
      nativePath: null,
    }), async () => { accepted = true; })).resolves.toBe(false);

    expect(accepted).toBe(false);
    expect(fake.steerTurn).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(false);
  });

  it('executes goal controls immediately on the active client and waits for the turn boundary', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      setThreadGoalStatus: async (threadId, status) => ({
        goal: makeGoal(threadId, 'Long-running work', status),
      }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
      operation: published.operation,
    }));

    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal pause',
      codexGoalCommand: { kind: 'pause' },
      nativePath: null,
    }));

    expect(fake.setThreadGoalStatus).toHaveBeenCalledWith('thread-1', 'paused');
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.resumeThread).toHaveBeenCalledTimes(1);
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });
    await finished;
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('keeps the current turn alive when an active goal is cleared before its boundary', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      clearThreadGoal: async () => ({ cleared: true }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Clear safely' },
      nativePath: null,
      operation: published.operation,
    }));

    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal clear',
      codexGoalCommand: { kind: 'clear' },
      nativePath: null,
    }));
    fake.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 'thread-1' },
    });

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });
    await finished;
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('finishes a paused active goal immediately between automatic turns', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      setThreadGoalStatus: async (threadId, status) => ({
        goal: makeGoal(threadId, 'Long-running work', status),
      }),
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });

    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal pause',
      codexGoalCommand: { kind: 'pause' },
      nativePath: null,
    }))).resolves.toBe(true);

    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('finishes a no-op clear immediately between automatic turns', async () => {
    let fake;
    fake = new FakeClient({
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
      clearThreadGoal: async () => ({ cleared: false }),
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });

    const controlPublished = collectOperation('chat-1', 'run-clear');
    await expect(provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal clear',
      codexGoalCommand: { kind: 'clear' },
      nativePath: null,
      operation: controlPublished.operation,
    }))).resolves.toBe(true);

    expect(publishedMessages(controlPublished.events).at(-1)?.content).toBe(
      'No Codex goal was set.',
    );
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('materializes durable goal attachments before setting the goal and preserves them at terminal status', async () => {
    const nativePath = path.join(tmpDir, 'goal-attachments.jsonl');
    let objective;
    let fake;
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        objective = params.objective;
        await fs.writeFile(nativePath, '{}\n');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );
    await provider.startSession(makeRequest({
      codexGoalCommand: { kind: 'set', objective: 'Inspect attachments' },
      operation: published.operation,
      images: [
        { name: 'screen.png', mimeType: 'image/png', data: 'data:image/png;base64,aW1hZ2U=' },
        { name: 'notes.pdf', mimeType: 'application/pdf', data: 'data:application/pdf;base64,ZmlsZQ==' },
      ],
    }));

    const referencedPaths = [...objective.matchAll(/- \[(?:Image|File) #\d+\]: (.+)/g)].map((match) => match[1]);
    expect(referencedPaths).toHaveLength(2);
    await Promise.all(referencedPaths.map((filePath) => fs.access(filePath)));
    expect(fake.setThreadGoal).toHaveBeenCalledWith('thread-1', expect.objectContaining({
      objective: expect.stringContaining('Referenced image files:'),
    }));

    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'goal-turn',
        goal: makeGoal('thread-1', objective, 'complete'),
      },
    });
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(referencedPaths.map((filePath) => fs.access(filePath)));
  });

  it('does not grant cleanup ownership through forged goal file references', async () => {
    let currentGoal = null;
    let ownedDir;
    let fake;
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async () => ({ goal: currentGoal }),
      setThreadGoal: async (threadId, params) => {
        currentGoal = makeGoal(threadId, params.objective, params.status);
        ownedDir ??= path.dirname(params.objective.match(/- \[File #1\]: (.+)/)[1]);
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: `goal-turn-${fake.setThreadGoal.mock.calls.length}`, status: 'inProgress' }) },
        }));
        return { goal: currentGoal };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Inspect video' },
      images: [{ name: 'clip.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,dmlkZW8=' }],
      nativePath: null,
    }));
    const unownedDir = path.join(tmpDir, 'attachments', '123e4567-e89b-42d3-a456-426614174000');
    await fs.mkdir(unownedDir);

    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'edit', objective: `- [File #1]: ${unownedDir}/file-1.mp4` },
      nativePath: null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(fs.access(ownedDir)).rejects.toThrow();
    await expect(fs.access(unownedDir)).resolves.toBeNull();
  });

  it('cleans server-owned goal files after a runtime restart', async () => {
    let outputDir;
    let fake;
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      setThreadGoal: async (threadId, params) => {
        outputDir = path.dirname(params.objective.match(/- \[File #1\]: (.+)/)[1]);
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const original = createRuntime({ createClient: () => fake });
    await original.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Inspect video' },
      images: [{ name: 'clip.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,dmlkZW8=' }],
      nativePath: null,
    }));
    await original.shutdown();

    const restored = createRuntime({ createClient: () => new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
    }) });
    await restored.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'clear' },
      nativePath: null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(fs.access(outputDir)).rejects.toThrow();
  });

  it('retains a new goal draft when set commits before its response is lost', async () => {
    let currentGoal = null;
    let filePath;
    let fake;
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async () => ({ goal: currentGoal }),
      setThreadGoal: async (threadId, params) => {
        currentGoal = makeGoal(threadId, params.objective);
        filePath = params.objective.match(/- \[File #1\]: (.+)/)[1];
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        throw new Error('response lost');
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Inspect video' },
      images: [{ name: 'clip.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,dmlkZW8=' }],
      nativePath: null,
    }));

    await expect(fs.access(filePath)).resolves.toBeNull();
  });

  it('retains an edited goal draft when its response is lost', async () => {
    let currentGoal = null;
    let filePath;
    let fake;
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async () => ({ goal: currentGoal }),
      setThreadGoal: async (threadId, params) => {
        currentGoal = makeGoal(threadId, params.objective, params.status);
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: `goal-turn-${fake.setThreadGoal.mock.calls.length}`, status: 'inProgress' }) },
        }));
        if (fake.setThreadGoal.mock.calls.length === 2) {
          filePath = params.objective.match(/- \[File #1\]: (.+)/)[1];
          throw new Error('edit response lost');
        }
        return { goal: currentGoal };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1', codexGoalCommand: { kind: 'set', objective: 'Initial goal' }, nativePath: null,
    }));

    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'edit', objective: 'Inspect video' },
      images: [{ name: 'clip.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,dmlkZW8=' }],
      nativePath: null,
    }));

    await expect(fs.access(filePath)).resolves.toBeNull();
  });

  it('retains a replacement draft when replacement commits before its response is lost', async () => {
    let currentGoal = null;
    let filePath;
    let fake;
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async () => ({ goal: currentGoal }),
      clearThreadGoal: async () => { currentGoal = null; return { cleared: true }; },
      setThreadGoal: async (threadId, params) => {
        const call = fake.setThreadGoal.mock.calls.length;
        if (call === 3) throw new Error('rollback response lost');
        currentGoal = makeGoal(threadId, params.objective, params.status);
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: `goal-turn-${call}`, status: 'inProgress' }) },
        }));
        if (call === 2) {
          filePath = params.objective.match(/- \[File #1\]: (.+)/)[1];
          throw new Error('replacement response lost');
        }
        return { goal: currentGoal };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1', codexGoalCommand: { kind: 'set', objective: 'Initial goal' }, nativePath: null,
    }));

    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Inspect video' },
      images: [{ name: 'clip.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,dmlkZW8=' }],
      nativePath: null,
    }));

    await expect(fs.access(filePath)).resolves.toBeNull();
  });

  it('preserves an externally selected goal when a failed mutation reconciles to a third objective', async () => {
    const external = await materializeGoalDraft(tmpDir, 'thread-1', 'External goal', [
      { name: 'external.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,ZXh0ZXJuYWw=' },
    ]);
    let attemptedDir;
    let goalReadCount = 0;
    const fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async (threadId) => ({
        goal: goalReadCount++ === 0 ? null : makeGoal(threadId, external.objective),
      }),
      setThreadGoal: async (_threadId, params) => {
        attemptedDir = path.dirname(params.objective.match(/- \[File #1\]: (.+)/)[1]);
        throw new Error('mutation response lost');
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Attempted goal' },
      images: [{ name: 'attempt.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,YXR0ZW1wdA==' }],
      nativePath: null,
    }));

    await expect(fs.access(attemptedDir)).rejects.toThrow();
    await expect(fs.access(external.outputDir)).resolves.toBeNull();
  });

  it('serializes goal cleanup before materializing the next edited goal', async () => {
    let currentGoal = null;
    let fake;
    let releaseCleanup;
    let signalCleanupStarted;
    const cleanupStarted = new Promise((resolve) => { signalCleanupStarted = resolve; });
    const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
    let cleanupCount = 0;
    const referencedFiles = [];
    const delayedCleanup = mock(async (...args) => {
      cleanupCount += 1;
      if (cleanupCount === 2) {
        signalCleanupStarted();
        await cleanupGate;
      }
      await cleanupOwnedGoalAttachments(...args);
    });
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async () => ({ goal: currentGoal }),
      setThreadGoal: async (threadId, params) => {
        currentGoal = makeGoal(threadId, params.objective, params.status);
        const reference = params.objective.match(/- \[File #1\]: (.+)/)?.[1];
        if (reference) referencedFiles.push(reference);
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: `goal-turn-${fake.setThreadGoal.mock.calls.length}`, status: 'inProgress' }) },
        }));
        return { goal: currentGoal };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      cleanupOwnedGoalAttachments: delayedCleanup,
    });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1', codexGoalCommand: { kind: 'set', objective: 'Initial goal' }, nativePath: null,
    }));

    const firstEdit = provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'edit', objective: 'First edit' },
      images: [{ name: 'first.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,Zmlyc3Q=' }],
      nativePath: null,
    }));
    await cleanupStarted;
    const secondEdit = provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'edit', objective: 'Second edit' },
      images: [{ name: 'second.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,c2Vjb25k' }],
      nativePath: null,
    }));
    await Promise.resolve();

    expect(fake.setThreadGoal).toHaveBeenCalledTimes(2);
    releaseCleanup();
    await Promise.all([firstEdit, secondEdit]);

    expect(fake.setThreadGoal).toHaveBeenCalledTimes(3);
    await expect(fs.access(referencedFiles[0])).rejects.toThrow();
    await expect(fs.access(referencedFiles[1])).resolves.toBeNull();
  });

  it('ignores a delayed explicit-clear notification after a new attached goal commits', async () => {
    let currentGoal = null;
    let replacementFile;
    let fake;
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async () => ({ goal: currentGoal }),
      clearThreadGoal: async () => {
        currentGoal = null;
        return { cleared: true };
      },
      setThreadGoal: async (threadId, params) => {
        currentGoal = makeGoal(threadId, params.objective, params.status);
        replacementFile = params.objective.match(/- \[File #1\]: (.+)/)?.[1] ?? replacementFile;
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: `goal-turn-${fake.setThreadGoal.mock.calls.length}`, status: 'inProgress' }) },
        }));
        return { goal: currentGoal };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1', codexGoalCommand: { kind: 'set', objective: 'Initial goal' }, nativePath: null,
    }));
    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1', codexGoalCommand: { kind: 'clear' }, nativePath: null,
    }));
    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Replacement goal' },
      images: [{ name: 'replacement.mp4', mimeType: 'video/mp4', data: 'data:video/mp4;base64,cmVwbGFjZW1lbnQ=' }],
      nativePath: null,
    }));

    fake.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 'thread-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(fs.access(replacementFile)).resolves.toBeNull();
    expect(provider.isRunning('thread-1')).toBe(true);
  });

  it('stores oversized goal objectives in a durable Codex attachment file', async () => {
    const nativePath = path.join(tmpDir, 'large-goal.jsonl');
    const largeObjective = 'x'.repeat(4_001);
    let storedObjective;
    let fake;
    fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        storedObjective = params.objective;
        await fs.writeFile(nativePath, '{}\n');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }) },
        }));
        return { goal: makeGoal(threadId, params.objective) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.startSession(makeRequest({
      command: largeObjective,
      codexGoalCommand: { kind: 'set', objective: largeObjective },
    }));

    const objectivePath = storedObjective
      .replace('Read the Codex goal objective file at ', '')
      .replace(' before continuing.', '');
    expect(path.basename(objectivePath)).toBe('goal-objective.md');
    expect(await fs.readFile(objectivePath, 'utf8')).toBe(largeObjective);
  });

  it('cleans newly materialized goal files when goal set fails', async () => {
    let outputDir;
    const fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (_threadId, params) => {
        const match = params.objective.match(/- \[Image #1\]: (.+)/);
        outputDir = path.dirname(match[1]);
        throw new Error('goal set rejected');
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Draft with image' },
      images: [{ name: 'screen.png', mimeType: 'image/png', data: 'data:image/png;base64,aW1hZ2U=' }],
      nativePath: null,
    }));

    expect(outputDir).toBeTruthy();
    await expect(fs.access(outputDir)).rejects.toThrow();
  });

  it('cleans newly materialized goal files when replacement clear fails', async () => {
    const fake = new FakeClient({
      connect: async () => ({ userAgent: 'codex', codexHome: tmpDir, platformFamily: 'unix', platformOs: 'linux' }),
      getThreadGoal: async (threadId) => ({ goal: makeGoal(threadId, 'Existing goal', 'blocked') }),
      clearThreadGoal: async () => { throw new Error('goal clear rejected'); },
    });
    const provider = createRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement with image' },
      images: [{ name: 'screen.png', mimeType: 'image/png', data: 'data:image/png;base64,aW1hZ2U=' }],
      nativePath: null,
    }));

    expect(fake.setThreadGoal).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(tmpDir, 'attachments'))).toEqual([]);
  });

  it('loads history from native Codex JSONL, including raw tool calls', async () => {
    const nativePath = path.join(tmpDir, 'history-thread.jsonl');
    await writeJsonl(nativePath, [
      {
        type: 'session_meta',
        timestamp: '2026-02-21T09:59:59.000Z',
        payload: { id: 'thread-1', history_mode: 'legacy' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-21T10:00:00.000Z',
        payload: { type: 'user_message', message: 'load this' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-21T10:00:01.000Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"rg --files","workdir":"/repo"}',
          call_id: 'call_1',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-21T10:00:02.000Z',
        payload: { type: 'function_call_output', call_id: 'call_1', output: 'server/index.ts' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-21T10:00:03.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Loaded from JSONL' }],
        },
      },
    ]);
    const fake = new FakeClient();
    const provider = createRuntime({ createClient: () => fake });

    const messages = await provider.loadMessages({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath,
      projectPath: '/repo',
    });

    expect(fake.connect).toHaveBeenCalledTimes(0);
    expect(messages.map((message) => message.type)).toEqual([
      'user-message',
      'bash-tool-use',
      'tool-result',
      'assistant-message',
    ]);
    expect(messages[3].content).toBe('Loaded from JSONL');
  });

  it('loads paginated history through canonical turn shells and item pages', async () => {
    const nativePath = path.join(tmpDir, 'paginated-thread.jsonl');
    await writeJsonl(nativePath, [{
      type: 'session_meta',
      timestamp: '2026-07-20T00:00:00.000Z',
      payload: { id: 'thread-1', history_mode: 'paginated', history_base: null },
    }, {
      type: 'response_item',
      timestamp: '2026-07-20T00:00:01.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'raw duplicate' }] },
    }]);
    const fake = new FakeClient({
      listThreadTurns: async () => ({
        data: [makeTurn({ items: [], itemsView: 'notLoaded' })],
        nextCursor: null,
        backwardsCursor: null,
      }),
      listThreadItems: async () => ({
        data: [
          {
            turnId: 'turn-1',
            item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'canonical prompt' }] },
          },
          {
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'assistant-1', text: 'canonical answer', phase: null, memoryCitation: null },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      }),
    });
    const provider = createRuntime({ createClient: () => fake });

    const messages = await provider.loadMessages({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath,
      projectPath: '/repo',
    });

    expect(messages.map((message) => message.content)).toEqual([
      'canonical prompt',
      'canonical answer',
    ]);
    expect(messages.some((message) => message.content === 'raw duplicate')).toBe(false);
    expect(fake.listThreadTurns).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      sortDirection: 'asc',
      itemsView: 'notLoaded',
    }));
    expect(fake.listThreadItems).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      turnId: null,
      sortDirection: 'asc',
    }));
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('loads inherited paginated history through the leaf thread', async () => {
    const nativePath = path.join(tmpDir, 'inherited-paginated-thread.jsonl');
    await writeJsonl(nativePath, [{
      type: 'session_meta',
      timestamp: '2026-07-20T00:00:00.000Z',
      payload: {
        id: 'thread-1',
        history_mode: 'paginated',
        history_base: { thread_id: 'thread-0', end_ordinal_exclusive: 1, end_byte_offset: 10 },
      },
    }]);
    const fake = new FakeClient({
      listThreadTurns: async () => ({
        data: [makeTurn({ id: 'turn-inherited', items: [], itemsView: 'notLoaded' })],
        nextCursor: null,
        backwardsCursor: null,
      }),
      listThreadItems: async () => ({
        data: [{
          turnId: 'turn-inherited',
          item: {
            type: 'agentMessage',
            id: 'assistant-inherited',
            text: 'inherited answer',
            phase: null,
            memoryCitation: null,
          },
        }],
        nextCursor: null,
        backwardsCursor: null,
      }),
    });
    const provider = createRuntime({ createClient: () => fake });

    await expect(provider.loadMessages({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath,
      projectPath: '/repo',
    })).resolves.toMatchObject([{ type: 'assistant-message', content: 'inherited answer' }]);
    expect(fake.listThreadTurns).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
    }));
    expect(fake.listThreadItems).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
    }));
  });

  it('resolves missing native paths through thread/list without loading threads', async () => {
    const nativePath = path.join(tmpDir, 'resolved-thread.jsonl');
    await fs.writeFile(nativePath, '{}\n');
    const fake = new FakeClient({
      listThreads: async () => ({
        data: [makeThread({ id: 'thread-1', path: nativePath })],
        nextCursor: null,
        backwardsCursor: null,
      }),
    });
    const provider = createRuntime({ createClient: () => fake });

    const resolvedPath = await provider.resolveNativePath({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });

    expect(fake.listThreads).toHaveBeenCalledWith(expect.objectContaining({ useStateDbOnly: false }));
    expect(resolvedPath).toBe(nativePath);
  });

  it('shares cached discovery misses until an explicit transcript load requests a refresh', async () => {
    const nativePath = path.join(tmpDir, 'later-resolved-thread.jsonl');
    await fs.writeFile(nativePath, '{}\n');
    let discoverable = false;
    const fake = new FakeClient({
      listThreads: async () => ({
        data: discoverable ? [makeThread({ id: 'thread-1', path: nativePath })] : [],
        nextCursor: null,
        backwardsCursor: null,
      }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const session = {
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    };

    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    discoverable = true;
    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    expect(fake.listThreads).toHaveBeenCalledTimes(1);

    provider.requestNativePathDiscoveryRefresh('thread-1');
    await expect(provider.resolveNativePath(session)).resolves.toBe(nativePath);

    expect(fake.listThreads).toHaveBeenCalledTimes(2);
  });

  it('uses one discovery snapshot for sequential missing-session resolutions', async () => {
    const fake = new FakeClient();
    const provider = createRuntime({ createClient: () => fake });

    for (let index = 0; index < 100; index += 1) {
      await expect(provider.resolveNativePath({
        provider: 'codex',
        agentSessionId: `missing-thread-${index}`,
        nativePath: null,
        projectPath: '/repo',
      })).resolves.toBeNull();
    }

    expect(fake.listThreads).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated native path discovery refresh requests', async () => {
    let now = 0;
    const fake = new FakeClient();
    const provider = createRuntime({
      createClient: () => fake,
      nativePathDiscoveryRefresh: {
        sessionIntervalMs: 30_000,
        globalIntervalMs: 1_000,
        now: () => now,
      },
    });
    const session = {
      provider: 'codex',
      agentSessionId: 'missing-thread',
      nativePath: null,
      projectPath: '/repo',
    };

    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    provider.requestNativePathDiscoveryRefresh('missing-thread');
    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    provider.requestNativePathDiscoveryRefresh('missing-thread');
    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    expect(fake.listThreads).toHaveBeenCalledTimes(2);

    now = 30_000;
    provider.requestNativePathDiscoveryRefresh('missing-thread');
    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    expect(fake.listThreads).toHaveBeenCalledTimes(3);

    now = 0;
    provider.requestNativePathDiscoveryRefresh('missing-thread');
    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    expect(fake.listThreads).toHaveBeenCalledTimes(4);
  });

  it('lets another session request a refresh after the global minimum interval', async () => {
    let now = 0;
    const fake = new FakeClient();
    const provider = createRuntime({
      createClient: () => fake,
      nativePathDiscoveryRefresh: {
        sessionIntervalMs: 30_000,
        globalIntervalMs: 1_000,
        now: () => now,
      },
    });
    const session = {
      provider: 'codex',
      agentSessionId: 'missing-thread',
      nativePath: null,
      projectPath: '/repo',
    };

    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    provider.requestNativePathDiscoveryRefresh('background-thread');
    await expect(provider.resolveNativePath(session)).resolves.toBeNull();

    now = 100;
    provider.requestNativePathDiscoveryRefresh('user-thread');
    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    expect(fake.listThreads).toHaveBeenCalledTimes(2);

    now = 1_000;
    provider.requestNativePathDiscoveryRefresh('user-thread');
    await expect(provider.resolveNativePath(session)).resolves.toBeNull();
    expect(fake.listThreads).toHaveBeenCalledTimes(3);
  });

  it('surfaces thread/list failures during native path reconciliation', async () => {
    const fake = new FakeClient({
      listThreads: async () => {
        throw new Error('app-server unavailable');
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    await expect(provider.resolveNativePath({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    })).rejects.toThrow('app-server unavailable');

  });

  it('uses an operation-scoped client with effective env and config for forks', async () => {
    const nativePath = path.join(tmpDir, 'forked-thread.jsonl');
    const operationClient = new FakeClient({
      forkThread: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { thread: makeThread({ id: 'forked-thread', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' };
      },
      unsubscribeThread: async () => ({ status: 'unsubscribed' }),
    });
    const clientOptions = [];
    const provider = createRuntime({
      createClient: (options) => {
        clientOptions.push(options);
        return operationClient;
      },
      materializationTimeoutMs: 20,
    });

    const forked = await provider.forkSession({
      sourceSession: {
        provider: 'codex',
        agentSessionId: 'thread-1',
        nativePath: null,
        model: 'gpt-5.4-codex',
        projectPath: '/repo',
      },
      envOverrides: { OPENAI_API_KEY: 'endpoint-key' },
      codexConfig: {
        env: { CODEX_HOME: '/tmp/codex-home' },
        config: { model_provider: 'custom-openai' },
      },
    });

    expect(forked).toEqual({ agentSessionId: 'forked-thread', nativePath });
    expect(clientOptions[0].env).toMatchObject({
      OPENAI_API_KEY: 'endpoint-key',
      CODEX_HOME: '/tmp/codex-home',
    });
    expect(operationClient.forkThread).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      config: { model_provider: 'custom-openai' },
    }));
    expect(operationClient.unsubscribeThread).toHaveBeenCalledWith('forked-thread');
    expect(operationClient.shutdown).toHaveBeenCalledTimes(1);
  });

  it('clears thread/list native path caches when a session finishes', async () => {
    const runningNativePath = path.join(tmpDir, 'finished-thread.jsonl');
    const firstResolvedPath = path.join(tmpDir, 'first-resolved-thread.jsonl');
    const secondResolvedPath = path.join(tmpDir, 'second-resolved-thread.jsonl');
    await fs.writeFile(firstResolvedPath, '{}\n');
    await fs.writeFile(secondResolvedPath, '{}\n');
    let listedPath = firstResolvedPath;
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: runningNativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(runningNativePath, '{}\n');
        return { turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } };
      },
      listThreads: async () => ({
        data: [makeThread({ id: 'thread-1', path: listedPath })],
        nextCursor: null,
        backwardsCursor: null,
      }),
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));
    const session = {
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    };
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    const before = await provider.resolveNativePath(session);
    listedPath = secondResolvedPath;
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await finished;
    const after = await provider.resolveNativePath(session);

    expect(before).toBe(firstResolvedPath);
    expect(after).toBe(secondResolvedPath);
    expect(fake.listThreads).toHaveBeenCalledTimes(2);
  });

  it('does not backfill terminal JSONL rows during a healthy live turn', async () => {
    const nativePath = path.join(tmpDir, 'no-backfill-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await writeJsonl(nativePath, [{
          type: 'response_item',
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Final line' }],
          },
        }]);
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await finished;

    expect(publishedMessages(published.events)).toEqual([]);
  });

  it('uses live streaming as the source of truth on successful turn completion', async () => {
    const nativePath = path.join(tmpDir, 'live-source-thread.jsonl');
    const liveItem = { type: 'agentMessage', id: 'a1', text: 'Already emitted', phase: null, memoryCitation: null };
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await writeJsonl(nativePath, [
          {
            type: 'response_item',
            timestamp: new Date(Date.now() + 1_000).toISOString(),
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'JSONL should not append' }],
            },
          },
        ]);
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress', completedAt: null, durationMs: null }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: liveItem },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: makeTurn({ id: 'turn-1', items: [liveItem], itemsView: 'summary' }),
      },
    });
    await finished;

    const emitted = publishedMessages(published.events);
    expect(emitted.map((message) => message.content)).toEqual(['Already emitted']);
    expect(getNativeMessageRevisionSource(emitted[0])).toEqual({
      entryId: 'turn:turn-1:item:a1',
      withinSourceOrdinal: 0,
    });
  });

  it('uses the terminal agent summary when its item completion notification is absent', async () => {
    const terminalItem = {
      type: 'agentMessage',
      id: 'terminal-agent-message',
      text: 'Recovered final line',
      phase: null,
      memoryCitation: null,
    };
    const fake = new FakeClient();
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.runTurn(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: makeTurn({ id: 'turn-1', items: [terminalItem], itemsView: 'summary' }),
      },
    });
    await finished;

    expect(publishedMessages(published.events).map((message) => message.content)).toEqual([
      'Recovered final line',
    ]);
  });

  it('does not append native-only interrupted tools behind live assistant output', async () => {
    const nativePath = path.join(tmpDir, 'interrupted-native-tail.jsonl');
    const liveCommand = {
      type: 'commandExecution',
      id: 'live-command',
      command: 'printf observed-before-answer',
      cwd: '/repo',
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'observed command output',
      exitCode: 0,
      durationMs: 12,
    };
    const liveItem = {
      type: 'agentMessage',
      id: 'live-assistant',
      text: 'The live answer is already visible',
      phase: null,
      memoryCitation: null,
    };
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await writeJsonl(nativePath, [
          {
            timestamp: '2026-08-15T00:00:00.000Z',
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'shell',
              call_id: 'native-only-command',
              arguments: JSON.stringify({ command: ['echo', 'ran-before-the-answer'] }),
            },
          },
        ]);
        return {
          turn: makeTurn({
            id: 'turn-1',
            status: 'inProgress',
            completedAt: null,
            durationMs: null,
          }),
        };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    const finished = published.waitForEvent(
      (event) => event.type === 'run-ended' && event.outcome === 'finished',
    );

    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: liveCommand },
    });
    fake.emit('notification', {
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: liveItem },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: makeTurn({
          id: 'turn-1',
          status: 'interrupted',
          items: [liveCommand, liveItem],
          itemsView: 'summary',
        }),
      },
    });
    await finished;

    const emitted = publishedMessages(published.events);
    expect(emitted.map((message) => {
      if (message.type === 'bash-tool-use') {
        return [message.type, message.toolId, message.command];
      }
      if (message.type === 'tool-result') {
        return [message.type, message.toolId, message.content];
      }
      return [message.type, message.content];
    })).toEqual([
      ['bash-tool-use', 'live-command', 'printf observed-before-answer'],
      ['tool-result', 'live-command', { raw: 'observed command output' }],
      ['assistant-message', 'The live answer is already visible'],
    ]);
  });

  it('retries retryable utility app-server overload responses while resolving native paths', async () => {
    const nativePath = path.join(tmpDir, 'retry-thread.jsonl');
    await fs.writeFile(nativePath, '{}\n');
    let attempts = 0;
    const fake = new FakeClient({
      listThreads: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('Server overloaded; retry later.'), { code: -32001 });
        }
        return {
          data: [makeThread({ id: 'thread-1', path: nativePath })],
          nextCursor: null,
          backwardsCursor: null,
        };
      },
    });
    const provider = createRuntime({ createClient: () => fake });

    const resolvedPath = await provider.resolveNativePath({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });

    expect(attempts).toBe(2);
    expect(resolvedPath).toBe(nativePath);
  });

  it('routes app-server approval requests back to the pending JSON-RPC request', async () => {
    const nativePath = path.join(tmpDir, 'approval-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    fake.emit('serverRequest', {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'ls' },
    });

    const request = permissionEvents(published.events).find(
      (event) => event.lifecycle.kind === 'requested',
    );
    expect(request).toBeDefined();
    await request.decision.respond({ allow: true });

    expect(fake.respond).toHaveBeenCalledWith(7, { decision: 'accept' });
    expect(permissionEvents(published.events)).toHaveLength(1);
  });

  it('keeps write-stdin reviews distinct when they share a parent command', async () => {
    const nativePath = path.join(tmpDir, 'stdin-approval-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    for (const [requestId, approvalId] of [['stdin-request-a', 'stdin-approval-a'], ['stdin-request-b', 'stdin-approval-b']]) {
      fake.emit('serverRequest', {
        id: requestId,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'parent-command',
          approvalId,
          kind: 'writeStdin',
        },
      });
    }

    const requests = permissionEvents(published.events).filter(
      (event) => event.lifecycle.kind === 'requested',
    );
    expect(requests.map((event) => event.lifecycle.requestedTool.toolId)).toEqual([
      'stdin-approval-a',
      'stdin-approval-b',
    ]);
    await requests[0].decision.respond({ allow: true, alwaysAllow: true });
    await requests[1].decision.respond({ allow: false });
    expect(fake.respond.mock.calls).toEqual([
      ['stdin-request-a', { decision: 'accept' }],
      ['stdin-request-b', { decision: 'cancel' }],
    ]);
  });

  it('expires only the matching client request after external resolution', async () => {
    const paths = [
      path.join(tmpDir, 'approval-client-a.jsonl'),
      path.join(tmpDir, 'approval-client-b.jsonl'),
    ];
    const clients = paths.map((nativePath, index) => new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: `thread-${index + 1}`, path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: `turn-${index + 1}`, status: 'inProgress' }) };
      },
    }));
    let clientIndex = 0;
    const provider = createRuntime({ createClient: () => clients[clientIndex++] });
    const operations = [collectOperation('chat-1', 'run-a'), collectOperation('chat-2', 'run-b')];
    await provider.startSession(makeRequest({ chatId: 'chat-1', operation: operations[0].operation }));
    await provider.startSession(makeRequest({ chatId: 'chat-2', operation: operations[1].operation }));

    clients.forEach((client, index) => client.emit('serverRequest', {
      id: 'shared-request-id',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: `thread-${index + 1}`,
        turnId: `turn-${index + 1}`,
        itemId: `command-${index + 1}`,
        command: 'printf ready',
      },
    }));
    clients[0].emit('notification', {
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 'shared-request-id' },
    });

    expect(permissionEvents(operations[0].events).map((event) => event.lifecycle.kind))
      .toEqual(['requested', 'expired']);
    expect(permissionEvents(operations[1].events).map((event) => event.lifecycle.kind))
      .toEqual(['requested']);
    const first = permissionEvents(operations[0].events)[0];
    await expect(first.decision.respond({ allow: true }))
      .rejects.toThrow('no longer pending');
    const second = permissionEvents(operations[1].events)[0];
    await second.decision.respond({ allow: true });
    expect(clients[0].respond).not.toHaveBeenCalled();
    expect(clients[1].respond).toHaveBeenCalledWith('shared-request-id', { decision: 'accept' });
  });

  it('ignores external resolution after a local response', async () => {
    const nativePath = path.join(tmpDir, 'resolved-after-response.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('serverRequest', {
      id: 81,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', command: 'ls' },
    });
    const request = permissionEvents(published.events)[0];
    await request.decision.respond({ allow: true });
    fake.emit('notification', {
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 81 },
    });

    expect(permissionEvents(published.events).map((event) => event.lifecycle.kind))
      .toEqual(['requested']);
    expect(fake.respond).toHaveBeenCalledTimes(1);
  });

  it('[TLV5-PERM.09-CODEX-UNIT-01] denies and logs an approval without a concrete turn route', async () => {
    const nativePath = path.join(tmpDir, 'unowned-approval-thread.jsonl');
    const logger = {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    };
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake, logger });
    const published = collectOperation();
    await provider.startSession(makeRequest({ operation: published.operation }));

    fake.emit('serverRequest', {
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'missing-turn',
        itemId: 'sensitive-item-id',
        command: 'sensitive-command-must-not-be-logged',
      },
    });

    expect(permissionEvents(published.events)).toEqual([]);
    expect(fake.respond).toHaveBeenCalledWith(91, { decision: 'decline' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]).toEqual([
      'Dropped an unowned Codex approval request',
      {
        threadId: 'thread-1',
        nativeTurnId: 'missing-turn',
        method: 'item/commandExecution/requestApproval',
      },
    ]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('sensitive-item-id');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('sensitive-command-must-not-be-logged');
  });

  it('cancels approvals for one native turn through its captured turn operation', async () => {
    const nativePath = path.join(tmpDir, 'approval-routing-thread.jsonl');
    let goal = null;
    let fake;
    fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      getThreadGoal: async () => ({ goal }),
      setThreadGoal: async (threadId, params) => {
        goal = makeGoal(threadId, params.objective, 'active');
        await fs.writeFile(nativePath, '{}\n');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: {
            threadId,
            turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }),
          },
        }));
        return { goal };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');
    await provider.startSession(makeRequest({
      command: 'Keep working',
      codexGoalCommand: { kind: 'set', objective: 'Keep working' },
      operation: first.operation,
    }));

    fake.emit('serverRequest', {
      id: 71,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'goal-turn', itemId: 'cmd-a', command: 'command-a' },
    });
    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      nativePath,
      codexGoalCommand: { kind: 'status' },
      operation: second.operation,
    }));
    fake.emit('serverRequest', {
      id: 72,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'goal-turn', itemId: 'cmd-b', command: 'command-b' },
    });

    goal = makeGoal('thread-1', 'Keep working', 'complete');
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'goal-turn', goal },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });
    await Promise.resolve();

    const requests = permissionEvents(first.events).filter(
      (event) => event.lifecycle.kind === 'requested',
    );
    const requestByCommand = new Map(requests.map((event) => [
      event.lifecycle.requestedTool.command,
      event.lifecycle.permissionOccurrenceId,
    ]));
    expect(requestByCommand.has('command-a')).toBe(true);
    expect(requestByCommand.has('command-b')).toBe(true);
    expect(permissionEvents(second.events)).toEqual([]);

    const cancelledOccurrenceIds = permissionEvents(first.events)
      .filter((event) => event.lifecycle.kind === 'cancelled')
      .map((event) => event.lifecycle.permissionOccurrenceId);
    expect(cancelledOccurrenceIds).toEqual([
      requestByCommand.get('command-a'),
      requestByCommand.get('command-b'),
    ]);
    expect(fake.respond.mock.calls).toEqual([
      [71, { decision: 'decline' }],
      [72, { decision: 'decline' }],
    ]);
  });

  it('binds each native turn once across later operations and delayed starts', async () => {
    const nativePath = path.join(tmpDir, 'immutable-turn-routes.jsonl');
    let goal = null;
    let fake;
    fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      getThreadGoal: async () => ({ goal }),
      setThreadGoal: async (threadId, params) => {
        goal = makeGoal(threadId, params.objective, 'active');
        await fs.writeFile(nativePath, '{}\n');
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'turn-a', status: 'inProgress' }) },
        });
        return { goal };
      },
      setThreadGoalStatus: async (threadId) => {
        goal = makeGoal(threadId, 'Keep working', 'active');
        fake.emit('notification', {
          method: 'turn/started',
          params: { threadId, turn: makeTurn({ id: 'turn-b', status: 'inProgress' }) },
        });
        return { goal };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');

    await provider.startSession(makeRequest({
      codexGoalCommand: { kind: 'set', objective: 'Keep working' },
      operation: first.operation,
    }));
    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      nativePath,
      codexGoalCommand: { kind: 'resume' },
      operation: second.operation,
    }));

    fake.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-a', status: 'inProgress' }) },
    });
    for (const [turnId, itemId, text] of [
      ['turn-a', 'item-a', 'late from turn A'],
      ['turn-b', 'item-b', 'current from turn B'],
    ]) {
      fake.emit('notification', {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId,
          item: { type: 'agentMessage', id: itemId, text, phase: null, memoryCitation: null },
        },
      });
    }
    for (const [id, turnId, command] of [
      [81, 'turn-a', 'approval-a'],
      [82, 'turn-b', 'approval-b'],
    ]) {
      fake.emit('serverRequest', {
        id,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', turnId, itemId: `cmd-${id}`, command },
      });
    }
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-a' }) },
    });

    expect(publishedMessages(first.events).map((message) => message.content)).toContain(
      'late from turn A',
    );
    expect(publishedMessages(second.events).map((message) => message.content)).toContain(
      'current from turn B',
    );
    expect(permissionEvents(first.events)).toEqual([]);
    expect(fake.respond).toHaveBeenCalledWith(81, { decision: 'decline' });
    expect(permissionEvents(second.events).map(
      (event) => event.lifecycle.requestedTool?.command,
    )).toContain('approval-b');
    expect(terminalEvents(first.events)).toContainEqual(
      expect.objectContaining({ runId: 'run-a', outcome: 'finished' }),
    );
    expect(terminalEvents(second.events)).toEqual([]);
    expect(provider.captureSteerTarget('thread-1')).toBeTruthy();
  });

  it('[TLV5-L07.06-CODEX-UNIT-01] retains named turn routes through terminal publication until source retirement', async () => {
    const nativePath = path.join(tmpDir, 'post-terminal-route.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-a', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation('chat-1', 'run-a');
    await provider.startSession(makeRequest({
      operation: published.operation,
    }));

    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-a' }) },
    });
    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-a',
        item: {
          type: 'subAgentActivity',
          id: 'subagent-completed-worker',
          kind: 'completed',
          agentThreadId: 'worker-thread',
          agentPath: '/root/worker',
        },
      },
    });

    expect(publishedMessages(published.events)).toContainEqual(expect.objectContaining({
      action: 'agent_status',
      details: expect.objectContaining({
        target: '/root/worker',
        agentStates: { '/root/worker': { status: 'completed' } },
      }),
    }));
    expect(fake.shutdown).not.toHaveBeenCalled();

    fake.emit('serverRequest', {
      id: 'late-stdin-review',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-a',
        itemId: 'parent-command',
        approvalId: 'late-stdin-approval',
        kind: 'writeStdin',
      },
    });
    expect(fake.respond).toHaveBeenCalledWith('late-stdin-review', { decision: 'cancel' });
    expect(permissionEvents(published.events)).toEqual([]);

    fake.emit('exit', 0);
    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-a',
        item: { type: 'agentMessage', id: 'retired-item', text: 'after retirement', phase: null, memoryCitation: null },
      },
    });
    expect(publishedMessages(published.events).some(
      (message) => message.content === 'after retirement',
    )).toBe(false);
  });

  it('reactivates a retained source for the next turn without replacing old turn routes', async () => {
    const nativePath = path.join(tmpDir, 'reactivated-source.jsonl');
    let turnNumber = 0;
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        turnNumber += 1;
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: `turn-${turnNumber}`, status: 'inProgress' }) };
      },
    });
    const createClient = mock(() => fake);
    const provider = createRuntime({ createClient });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');

    const started = await provider.startSession(makeRequest({ operation: first.operation }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await provider.runTurn(makeRequest({
      agentSessionId: started.agentSessionId,
      nativePath,
      operation: second.operation,
    }));

    for (const [turnId, itemId, text] of [
      ['turn-1', 'late-old-item', 'late old output'],
      ['turn-2', 'current-item', 'current output'],
    ]) {
      fake.emit('notification', {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId,
          item: { type: 'agentMessage', id: itemId, text, phase: null, memoryCitation: null },
        },
      });
    }

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.resumeThread).not.toHaveBeenCalled();
    expect(fake.startTurn).toHaveBeenCalledTimes(2);
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(publishedMessages(first.events).map((message) => message.content))
      .toContain('late old output');
    expect(publishedMessages(second.events).map((message) => message.content))
      .toContain('current output');

    fake.emit('serverRequest', {
      id: 'old-turn-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'old-command',
        command: 'printf old',
      },
    });
    expect(fake.respond).toHaveBeenCalledWith('old-turn-approval', { decision: 'decline' });
    expect(permissionEvents(second.events)).toEqual([]);
  });

  it('waits for interrupt acknowledgement before reusing the writer without awaiting its terminal event', async () => {
    const nativePath = path.join(tmpDir, 'interrupted-writer.jsonl');
    let turnNumber = 0;
    let firstAttachmentPath;
    const interruptAcknowledgement = createDeferred();
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async (params) => {
        if (turnNumber === 0) {
          firstAttachmentPath = params.input.find((item) => item.type === 'localImage')?.path;
        }
        turnNumber += 1;
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: `turn-${turnNumber}`, status: 'inProgress' }) };
      },
      interruptTurn: async () => {
        await interruptAcknowledgement.promise;
        return {};
      },
    });
    const createClient = mock(() => fake);
    const provider = createRuntime({ createClient });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');

    const started = await provider.startSession(makeRequest({
      operation: first.operation,
      images: [{
        name: 'first.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,Zmlyc3Q=',
      }],
    }));
    expect(firstAttachmentPath).toBeDefined();
    await expect(fs.access(firstAttachmentPath)).resolves.toBeNull();
    const aborting = provider.abort(started.agentSessionId);
    const resumed = provider.runTurn(makeRequest({
      agentSessionId: started.agentSessionId,
      nativePath,
      operation: second.operation,
    }));
    await Bun.sleep(0);

    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(fake.resumeThread).not.toHaveBeenCalled();

    interruptAcknowledgement.resolve();
    await expect(aborting).resolves.toBe(true);
    await resumed;

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(fake.startTurn).toHaveBeenCalledTimes(2);
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(true);
    await waitForMissingPath(path.dirname(firstAttachmentPath));

    fake.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: makeTurn({ id: 'turn-1', status: 'interrupted' }),
      },
    });
    expect(provider.isRunning('thread-1')).toBe(true);
  });

  it('rejects genuinely concurrent same-thread use without opening a second writer', async () => {
    const nativePath = path.join(tmpDir, 'concurrent-writer.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const createClient = mock(() => fake);
    const provider = createRuntime({ createClient });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');

    const started = await provider.startSession(makeRequest({ operation: first.operation }));
    await expect(provider.runTurn(makeRequest({
      agentSessionId: started.agentSessionId,
      nativePath,
      operation: second.operation,
    }))).rejects.toMatchObject({ code: 'SESSION_BUSY' });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(fake.resumeThread).not.toHaveBeenCalled();
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(true);
  });

  it('retires an incompatible retained writer before resuming it in a new process', async () => {
    const nativePath = path.join(tmpDir, 'replaced-writer.jsonl');
    const oldClient = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const replacementClient = new FakeClient({
      resumeThread: async () => {
        expect(oldClient.shutdown).toHaveBeenCalledTimes(1);
        return {
          thread: makeThread({ id: 'thread-1', path: nativePath }),
          model: 'gpt-5.4-codex',
          modelProvider: 'custom-openai',
          serviceTier: null,
          cwd: '/repo',
        };
      },
      startTurn: async () => ({
        turn: makeTurn({ id: 'turn-2', status: 'inProgress' }),
      }),
    });
    const clients = [oldClient, replacementClient];
    const createClient = mock(() => clients.shift());
    const provider = createRuntime({ createClient });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');

    const started = await provider.startSession(makeRequest({ operation: first.operation }));
    oldClient.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await provider.runTurn(makeRequest({
      agentSessionId: started.agentSessionId,
      nativePath,
      codexConfig: { config: { model_provider: 'custom-openai' } },
      operation: second.operation,
    }));

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(replacementClient.resumeThread).toHaveBeenCalledTimes(1);
    expect(replacementClient.startTurn).toHaveBeenCalledTimes(1);
  });

  it('retires an idle retained source and resumes the thread in a fresh process', async () => {
    const nativePath = path.join(tmpDir, 'idle-retired-source.jsonl');
    const firstClient = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const replacementClient = new FakeClient({
      resumeThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => ({ turn: makeTurn({ id: 'turn-2', status: 'inProgress' }) }),
    });
    const clients = [firstClient, replacementClient];
    const createClient = mock(() => clients.shift());
    const provider = createRuntime({
      createClient,
      retainedSourceIdlePurge: { intervalMs: 5, maxIdleMs: 0 },
    });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');

    const started = await provider.startSession(makeRequest({ operation: first.operation }));
    firstClient.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    provider.startPurgeTimer();
    await waitForCondition(() => firstClient.shutdown.mock.calls.length > 0);

    await provider.runTurn(makeRequest({
      agentSessionId: started.agentSessionId,
      nativePath,
      operation: second.operation,
    }));

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(replacementClient.resumeThread).toHaveBeenCalledTimes(1);
    expect(replacementClient.startTurn).toHaveBeenCalledTimes(1);
  });

  it('reclaims a retained goal source whose loop ended while its goal stayed active', async () => {
    const nativePath = path.join(tmpDir, 'idle-goal-source.jsonl');
    let fake;
    fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      getThreadGoal: async () => ({ goal: null }),
      setThreadGoal: async (threadId, params) => {
        await fs.writeFile(nativePath, '{}\n');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: {
            threadId,
            turn: makeTurn({ id: 'goal-turn-1', status: 'inProgress', completedAt: null, durationMs: null }),
          },
        }));
        return { goal: makeGoal(threadId, params.objective ?? 'Long-running work', 'active') };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      retainedSourceIdlePurge: { intervalMs: 5, maxIdleMs: 0 },
    });
    const first = collectOperation('chat-1', 'run-a');
    await provider.startSession(makeRequest({
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      operation: first.operation,
    }));

    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn-1', status: 'interrupted' }) },
    });

    provider.startPurgeTimer();
    await waitForCondition(() => fake.shutdown.mock.calls.length > 0);
  });

  it('keeps an active session writer out of the idle retained-source sweep', async () => {
    const nativePath = path.join(tmpDir, 'active-source-sweep.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      retainedSourceIdlePurge: { intervalMs: 5, maxIdleMs: 0 },
    });
    const first = collectOperation('chat-1', 'run-a');
    await provider.startSession(makeRequest({ operation: first.operation }));

    provider.startPurgeTimer();
    await Bun.sleep(30);

    expect(fake.shutdown).not.toHaveBeenCalled();
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
  });

  it('marks a quiescent terminal retained source as reclaimable', () => {
    expect(isRetainedSourceInUse(usageSession(), new Map())).toBe(false);
  });

  it('keeps a retained source in use while it is the active writer for its thread', () => {
    const session = usageSession();
    expect(isRetainedSourceInUse(session, new Map([['thread-1', session]]))).toBe(true);
  });

  it.each([
    ['its status is still active', { status: 'interrupting' }],
    ['an interrupt acknowledgement is pending', { interruptAcknowledgement: Promise.resolve(true) }],
    ['a settings confirmation is pending', {
      pendingThreadSettings: { target: {}, timeout: null, resolve() {}, reject() {} },
    }],
    ['a turn start waiter is registered', (session) => {
      session.turnStartWaiters.add({ resolve() {}, reject() {} });
    }],
    ['a delivery is reserved', { activeDeliveryReservations: 1 }],
    ['a goal continuation is active', { managesGoalLifecycle: true, activeTurnId: 'turn-goal' }],
  ])('keeps a retained source in use while %s', (_label, mutate) => {
    const session = usageSession();
    if (typeof mutate === 'function') mutate(session);
    else Object.assign(session, mutate);
    expect(isRetainedSourceInUse(session, new Map())).toBe(true);
  });

  it('retires the previous same-chat source only after replacement activation succeeds', async () => {
    const nativePaths = [
      path.join(tmpDir, 'superseded-source-a.jsonl'),
      path.join(tmpDir, 'superseded-source-b.jsonl'),
    ];
    const clients = nativePaths.map((nativePath, index) => new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: `thread-${index + 1}`, path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: `turn-${index + 1}`, status: 'inProgress' }) };
      },
    }));
    let clientIndex = 0;
    const provider = createRuntime({ createClient: () => clients[clientIndex++] });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');

    await provider.startSession(makeRequest({ chatId: 'chat-1', operation: first.operation }));
    clients[0].emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    expect(clients[0].shutdown).not.toHaveBeenCalled();

    await provider.startSession(makeRequest({ chatId: 'chat-1', operation: second.operation }));
    expect(clients[0].shutdown).toHaveBeenCalledTimes(1);
    clients[0].emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'retired-item', text: 'retired output', phase: null, memoryCitation: null },
      },
    });
    clients[1].emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-2',
        turnId: 'turn-2',
        item: { type: 'agentMessage', id: 'current-item', text: 'current output', phase: null, memoryCitation: null },
      },
    });
    expect(publishedMessages(first.events).some((message) => message.content === 'retired output'))
      .toBe(false);
    expect(publishedMessages(second.events).map((message) => message.content)).toContain('current output');

    await provider.shutdown();
    expect(clients[0].shutdown).toHaveBeenCalledTimes(1);
    expect(clients[1].shutdown).toHaveBeenCalledTimes(1);
  });

  it('preserves a retained source when replacement activation fails', async () => {
    const oldPath = path.join(tmpDir, 'preserved-source.jsonl');
    const oldClient = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: oldPath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(oldPath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const failedClient = new FakeClient({
      startThread: async () => { throw new Error('replacement unavailable'); },
    });
    let clientIndex = 0;
    const clients = [oldClient, failedClient];
    const provider = createRuntime({ createClient: () => clients[clientIndex++] });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');

    await provider.startSession(makeRequest({ chatId: 'chat-1', operation: first.operation }));
    oldClient.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await expect(provider.startSession(makeRequest({
      chatId: 'chat-1',
      operation: second.operation,
    }))).rejects.toThrow('replacement unavailable');
    expect(oldClient.shutdown).not.toHaveBeenCalled();
    expect(failedClient.shutdown).toHaveBeenCalledTimes(1);

    oldClient.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'late-old-item', text: 'retained after failure', phase: null, memoryCitation: null },
      },
    });
    expect(publishedMessages(first.events).map((message) => message.content))
      .toContain('retained after failure');
  });

  it('[TLV5-L07.04-CODEX-UNIT-01] keeps identical native turn ids isolated by client and thread', async () => {
    const nativePaths = [
      path.join(tmpDir, 'shared-turn-a.jsonl'),
      path.join(tmpDir, 'shared-turn-b.jsonl'),
    ];
    const clients = nativePaths.map((nativePath, index) => new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: `thread-${index}`, path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'shared-turn', status: 'inProgress' }) };
      },
    }));
    let clientIndex = 0;
    const provider = createRuntime({ createClient: () => clients[clientIndex++] });
    const first = collectOperation('chat-a', 'run-a');
    const second = collectOperation('chat-b', 'run-b');
    await provider.startSession(makeRequest({
      chatId: 'chat-a',
      operation: first.operation,
    }));
    await provider.startSession(makeRequest({
      chatId: 'chat-b',
      operation: second.operation,
    }));

    for (const [index, text] of ['from chat A', 'from chat B'].entries()) {
      clients[index].emit('notification', {
        method: 'item/completed',
        params: {
          threadId: `thread-${index}`,
          turnId: 'shared-turn',
          item: { type: 'agentMessage', id: `item-${index}`, text, phase: null, memoryCitation: null },
        },
      });
    }

    expect(publishedMessages(first.events).map((message) => message.content)).toEqual([
      'from chat A',
    ]);
    expect(publishedMessages(second.events).map((message) => message.content)).toEqual([
      'from chat B',
    ]);
  });

  it('keeps a native turn with the run that started it after a later operation takes the session', async () => {
    const nativePath = path.join(tmpDir, 'turn-route-thread.jsonl');
    let goal = null;
    let fake;
    fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-1', path: nativePath }),
        model: 'gpt',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
      }),
      getThreadGoal: async () => ({ goal }),
      setThreadGoal: async (threadId, params) => {
        goal = makeGoal(threadId, params.objective, 'active');
        await fs.writeFile(nativePath, '{}\n');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: {
            threadId,
            turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }),
          },
        }));
        return { goal };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const first = collectOperation('chat-1', 'run-a');
    const second = collectOperation('chat-1', 'run-b');
    await provider.startSession(makeRequest({
      command: 'Keep working',
      codexGoalCommand: { kind: 'set', objective: 'Keep working' },
      operation: first.operation,
    }));
    await provider.submitGoalControl(makeRequest({
      agentSessionId: 'thread-1',
      nativePath,
      codexGoalCommand: { kind: 'status' },
      operation: second.operation,
    }));

    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'goal-turn',
        item: { type: 'agentMessage', id: 'goal-turn-item', text: 'still working', phase: null, memoryCitation: null },
      },
    });

    expect(publishedMessages(first.events).map((message) => message.content)).toContain(
      'still working',
    );
    expect(publishedMessages(second.events).some(
      (message) => typeof message.content === 'string' && message.content.includes('Keep working'),
    )).toBe(true);
  });

  it('[TLV5-L07.09-CODEX-UNIT-01] publishes compaction through the operation that requested it', async () => {
    const fake = new FakeClient();
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation('chat-1', 'run-compact');

    await provider.compact(makeRequest({
      agentSessionId: 'thread-1',
      nativePath: null,
      operation: published.operation,
    }));
    fake.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) },
    });
    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'compaction-note', text: 'compacted', phase: null, memoryCitation: null },
      },
    });

    expect(publishedMessages(published.events).map((message) => message.content)).toEqual([
      'compacted',
    ]);
  });

  it('auto-approves app-server approvals in manual bypass without emitting a permission row', async () => {
    const nativePath = path.join(tmpDir, 'manual-bypass-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();

    await provider.startSession(makeRequest({
      permissionMode: 'manualBypass',
      operation: published.operation,
    }));
    fake.emit('serverRequest', {
      id: 9,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'ls' },
    });

    expect(fake.respond).toHaveBeenCalledWith(9, { decision: 'accept' });
    expect(permissionEvents(published.events)).toEqual([]);
  });

  it('confirms combined settings when notification precedes the RPC response', async () => {
    const { fake, provider, published, started } = await startSettingsSession();
    const response = createDeferred();
    fake.updateThreadSettings.mockImplementation(async () => {
      emitThreadSettings(fake, {
        model: 'gpt-5.4-mini',
        effort: 'high',
        approvalPolicy: 'on-request',
      });
      await response.promise;
      return {};
    });
    let settled = false;

    const update = provider.updateSessionSettings(started.agentSessionId, {
      model: 'gpt-5.4-mini',
      permissionMode: 'manualBypass',
      thinkingMode: 'high',
    }).finally(() => { settled = true; });
    await Promise.resolve();

    expect(fake.updateThreadSettings).toHaveBeenCalledWith({
      threadId: 'thread-1',
      model: 'gpt-5.4-mini',
      effort: 'high',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    expect(settled).toBe(false);
    response.resolve();
    await update;

    await provider.updateSessionSettings(started.agentSessionId, {
      model: 'gpt-5.4-mini',
      permissionMode: 'manualBypass',
      thinkingMode: 'high',
    });
    expect(fake.updateThreadSettings).toHaveBeenCalledTimes(1);

    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        goal: makeGoal('thread-1', 'Continue automatically'),
      },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    fake.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'automatic-turn', status: 'inProgress' }) },
    });
    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'automatic-turn',
        item: {
          type: 'agentMessage',
          id: 'automatic-result',
          text: 'continued with confirmed settings',
          phase: null,
          memoryCitation: null,
        },
      },
    });

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(publishedMessages(published.events).at(-1)?.content)
      .toBe('continued with confirmed settings');
  });

  it('updates a retained idle source while preserving provider-default effort', async () => {
    const { fake, provider, started } = await startSettingsSession();
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(provider.hasSource('thread-1')).toBe(true);
    fake.updateThreadSettings.mockImplementation(async () => {
      emitThreadSettings(fake, {
        approvalPolicy: 'on-request',
        effort: 'medium',
      });
      return {};
    });

    await provider.updateSessionSettings(started.agentSessionId, {
      model: 'gpt-5.4-codex',
      permissionMode: 'manualBypass',
      thinkingMode: 'none',
    });

    expect(fake.updateThreadSettings).toHaveBeenCalledWith({
      threadId: 'thread-1',
      model: 'gpt-5.4-codex',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it('confirms requested effort before starting an automatic goal turn', async () => {
    const nativePath = path.join(tmpDir, 'goal-effort-thread.jsonl');
    const calls = [];
    let fake;
    fake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({
          id: 'thread-1',
          path: nativePath,
          model: 'gpt-5.4-codex',
          reasoningEffort: 'medium',
        }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
        reasoningEffort: 'medium',
      }),
      updateThreadSettings: async () => {
        calls.push('settings');
        emitThreadSettings(fake, { effort: 'high' });
        return {};
      },
      setThreadGoal: async (threadId, params) => {
        calls.push('goal');
        await fs.writeFile(nativePath, '{}\n');
        queueMicrotask(() => fake.emit('notification', {
          method: 'turn/started',
          params: {
            threadId,
            turn: makeTurn({ id: 'goal-turn', status: 'inProgress' }),
          },
        }));
        return { goal: makeGoal(threadId, params.objective, 'active') };
      },
    });
    const provider = createRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
    });

    await provider.startSession(makeRequest({
      thinkingMode: 'high',
      codexGoalCommand: { kind: 'set', objective: 'Continue automatically' },
    }));

    expect(calls).toEqual(['settings', 'goal']);
    expect(fake.updateThreadSettings).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      effort: 'high',
    }));
  });

  it('ignores wrong-source, wrong-thread, and stale settings snapshots', async () => {
    const paths = [
      path.join(tmpDir, 'settings-source-a.jsonl'),
      path.join(tmpDir, 'settings-source-b.jsonl'),
    ];
    const clients = paths.map((nativePath, index) => new FakeClient({
      startThread: async () => ({
        thread: makeThread({
          id: `thread-${index + 1}`,
          path: nativePath,
          model: 'gpt-5.4-codex',
          reasoningEffort: 'medium',
        }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
        reasoningEffort: 'medium',
      }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: `turn-${index + 1}`, status: 'inProgress' }) };
      },
    }));
    let nextClient = 0;
    const provider = createRuntime({
      createClient: () => clients[nextClient++],
      materializationTimeoutMs: 20,
    });
    await provider.startSession(makeRequest({ chatId: 'chat-1' }));
    await provider.startSession(makeRequest({ chatId: 'chat-2' }));
    let settled = false;
    const update = provider.updateSessionSettings('thread-1', {
      model: 'gpt-5.4-mini',
      permissionMode: 'default',
      thinkingMode: 'high',
    }).finally(() => { settled = true; });
    await Promise.resolve();

    emitThreadSettings(clients[1], { model: 'gpt-5.4-mini', effort: 'high' }, 'thread-1');
    emitThreadSettings(clients[0], { model: 'gpt-5.4-mini', effort: 'high' }, 'thread-2');
    emitThreadSettings(clients[0]);
    await Promise.resolve();
    expect(settled).toBe(false);

    emitThreadSettings(clients[0], {
      model: 'gpt-5.4-mini',
      effort: 'high',
      approvalPolicy: 'untrusted',
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emitThreadSettings(clients[0], {
      model: 'gpt-5.4-mini',
      effort: 'high',
      approvalPolicy: { reject: { sandbox: true } },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emitThreadSettings(clients[0], {
      model: 'gpt-5.4-mini',
      effort: 'high',
      approvalsReviewer: 'auto_review',
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emitThreadSettings(clients[0], { model: 'gpt-5.4-mini', effort: 'high' });
    await update;
    expect(settled).toBe(true);
  });

  it('serializes settings updates for one app-server source', async () => {
    const { fake, provider, started } = await startSettingsSession();
    const first = provider.updateSessionSettings(started.agentSessionId, {
      model: 'gpt-5.4-mini',
      permissionMode: 'default',
      thinkingMode: 'high',
    });
    const second = provider.updateSessionSettings(started.agentSessionId, {
      model: 'gpt-5.4-mini',
      permissionMode: 'bypassPermissions',
      thinkingMode: 'low',
    });
    await Promise.resolve();
    expect(fake.updateThreadSettings).toHaveBeenCalledTimes(1);

    emitThreadSettings(fake, { model: 'gpt-5.4-mini', effort: 'high' });
    await first;
    await Promise.resolve();
    expect(fake.updateThreadSettings).toHaveBeenCalledTimes(2);

    emitThreadSettings(fake, {
      model: 'gpt-5.4-mini',
      effort: 'low',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    await second;
  });

  it('changes approval behavior only after settings confirmation', async () => {
    const { fake, provider, published, started } = await startSettingsSession();
    const update = provider.updateSessionSettings(started.agentSessionId, {
      model: 'gpt-5.4-codex',
      permissionMode: 'manualBypass',
      thinkingMode: 'medium',
    });
    await Promise.resolve();

    fake.emit('serverRequest', {
      id: 'before-confirmation',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-before', command: 'ls' },
    });
    expect(fake.respond).not.toHaveBeenCalled();
    expect(permissionEvents(published.events).map((event) => event.lifecycle.kind))
      .toEqual(['requested']);

    emitThreadSettings(fake, { approvalPolicy: 'on-request' });
    await update;
    fake.emit('serverRequest', {
      id: 'after-confirmation',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-after', command: 'pwd' },
    });

    expect(fake.respond).toHaveBeenCalledWith('after-confirmation', { decision: 'accept' });
    expect(permissionEvents(published.events).map((event) => event.lifecycle.kind))
      .toEqual(['requested']);
  });

  it('rejects RPC failure and source exit while settings are pending', async () => {
    const first = await startSettingsSession();
    first.fake.updateThreadSettings.mockRejectedValue(new Error('settings rejected'));
    await expect(first.provider.updateSessionSettings(first.started.agentSessionId, {
      model: 'gpt-5.4-mini',
      permissionMode: 'default',
      thinkingMode: 'high',
    })).rejects.toThrow('settings rejected');

    const secondPath = path.join(tmpDir, 'settings-exit-thread.jsonl');
    const secondFake = new FakeClient({
      startThread: async () => ({
        thread: makeThread({ id: 'thread-exit', path: secondPath }),
        model: 'gpt-5.4-codex',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/repo',
        reasoningEffort: 'medium',
      }),
      startTurn: async () => {
        await fs.writeFile(secondPath, '{}\n');
        return { turn: makeTurn({ id: 'turn-exit', status: 'inProgress' }) };
      },
      updateThreadSettings: () => new Promise(() => {}),
    });
    const secondProvider = createRuntime({
      createClient: () => secondFake,
      materializationTimeoutMs: 20,
    });
    await secondProvider.startSession(makeRequest({ chatId: 'chat-exit' }));
    const pending = secondProvider.updateSessionSettings('thread-exit', {
      model: 'gpt-5.4-mini',
      permissionMode: 'default',
      thinkingMode: 'high',
    });
    await Promise.resolve();
    secondFake.emit('exit', 0);

    await expect(pending).rejects.toThrow('retired before settings were confirmed');
    expect(secondProvider.isRunning('thread-exit')).toBe(false);
  });

  it('fences automatic turns after an ambiguous settings timeout', async () => {
    const { fake, provider, published, started } = await startSettingsSession({
      settingsUpdateTimeoutMs: 5,
    });
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        goal: makeGoal('thread-1', 'Continue automatically'),
      },
    });

    await expect(provider.updateSessionSettings(started.agentSessionId, {
      model: 'gpt-5.4-mini',
      permissionMode: 'default',
      thinkingMode: 'high',
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    expect(provider.isRunning('thread-1')).toBe(true);
    fake.emit('notification', {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: makeTurn({ id: 'automatic-after-timeout', status: 'inProgress' }),
      },
    });
    await Promise.resolve();

    expect(fake.interruptTurn).toHaveBeenCalledWith('thread-1', 'automatic-after-timeout');
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(failureMessages(published.events)).toContain(
      'Codex automatic turn blocked after an ambiguous settings update',
    );
  });

  it('does not re-emit the submitted prompt when app-server echoes userMessage items', async () => {
    const nativePath = path.join(tmpDir, 'live-user-echo-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } };
      },
    });
    const provider = createRuntime({ createClient: () => fake });
    const published = collectOperation();

    await provider.startSession(makeRequest({ operation: published.operation }));
    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hello', text_elements: [] }] },
      },
    });
    fake.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'a1', text: 'Hi there', phase: null, memoryCitation: null },
      },
    });

    expect(publishedMessages(published.events).map((message) => message.type)).toEqual([
      'assistant-message',
    ]);
    expect(publishedMessages(published.events)[0].content).toBe('Hi there');
  });
});
