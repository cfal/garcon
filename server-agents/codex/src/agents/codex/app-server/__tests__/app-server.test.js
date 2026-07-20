import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CodexSubagentToolUseMessage, ExecToolUseMessage, PermissionRequestMessage, PermissionResolvedMessage, ToolResultMessage, WaitToolUseMessage, codexSubagentSourceFingerprint } from '@garcon/common/chat-types';
import { buildApprovalResponse, createPendingApproval } from '../approvals.ts';
import { CodexAppServerClient, CodexAppServerRpcError } from '../client.ts';
import { convertCodexAppServerItem, convertCodexAppServerLiveItem, convertCodexRawCodeModeItem } from '../converter.ts';
import { waitForMaterializedThread } from '../durability.ts';
import { CodexAppServerRuntime } from '../runtime.ts';
import { loadCodexChatMessages } from '../../history-loader.ts';
import { ChatExecutionCoordinator } from '../../../../../../../server/chat-execution/chat-execution-coordinator.ts';
import { PendingUserInputService } from '../../../../../../../server/chats/pending-user-input-service.ts';
import {
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  mapThinkingModeToCodexEffort,
} from '../request-builders.ts';

function makeRequest(overrides = {}) {
  return {
    chatId: 'chat-1',
    command: 'hello',
    projectPath: '/repo',
    model: 'gpt-5.4-codex',
    permissionMode: 'default',
    thinkingMode: 'medium',
    ...overrides,
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

class FakeClient extends EventEmitter {
  constructor(script = {}) {
    super();
    this.script = script;
    this.startThread = mock(script.startThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.resumeThread = mock(script.resumeThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.forkThread = mock(script.forkThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.setThreadGoal = mock(script.setThreadGoal ?? (async (threadId, params) => ({
      goal: makeGoal(threadId, params.objective ?? 'Ship the feature', params.status ?? 'active'),
    })));
    this.setThreadGoalStatus = mock(script.setThreadGoalStatus ?? (async (threadId, status) => ({ goal: makeGoal(threadId, 'Ship the feature', status) })));
    this.getThreadGoal = mock(script.getThreadGoal ?? (async () => ({ goal: null })));
    this.clearThreadGoal = mock(script.clearThreadGoal ?? (async () => ({ cleared: true })));
    this.injectThreadItems = mock(script.injectThreadItems ?? (async () => ({})));
    this.listThreads = mock(script.listThreads ?? (async () => ({ data: [], nextCursor: null, backwardsCursor: null })));
    this.listThreadTurns = mock(script.listThreadTurns ?? (async () => ({ data: [], nextCursor: null, backwardsCursor: null })));
    this.loadedThreads = mock(script.loadedThreads ?? (async () => ({ data: [] })));
    this.unsubscribeThread = mock(script.unsubscribeThread ?? (async () => ({ status: 'notSubscribed' })));
    this.startTurn = mock(script.startTurn ?? (async () => ({ turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } })));
    this.steerTurn = mock(script.steerTurn ?? (async ({ expectedTurnId }) => ({ turnId: expectedTurnId })));
    this.interruptTurn = mock(script.interruptTurn ?? (async () => ({})));
    this.compactThread = mock(script.compactThread ?? (async () => ({})));
    this.connect = mock(script.connect ?? (async () => ({ userAgent: 'codex', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' })));
    this.respond = mock();
    this.reject = mock();
    this.shutdown = mock();
  }
}

function createRpcClientFixture(responder) {
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
  const proc = {
    stdin: {
      write(data) {
        const line = String(data).trim();
        const message = JSON.parse(line);
        writes.push(message);
        if (typeof message.id !== 'number') return;

        const response = responder(message);
        if (response?.error) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ id: message.id, error: response.error })}\n`));
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify({ id: message.id, result: response })}\n`));
      },
    },
    stdout,
    stderr: null,
    exited,
    kill: mock(() => {
      try {
        controller.close();
      } catch {
        // The stream may already be closed by the test.
      }
      resolveExit(0);
    }),
  };
  const spawn = mock(() => proc);
  const client = new CodexAppServerClient({
    spawn,
    resolveCli: async () => ({ command: '/tmp/codex', source: 'bundled' }),
  });
  return { client, writes, spawn, proc };
}

const initializeResponse = {
  userAgent: 'codex',
  codexHome: '/tmp/codex-home',
  platformFamily: 'unix',
  platformOs: 'linux',
};

describe('CodexAppServerClient lifecycle RPCs', () => {
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
    client.shutdown();

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
      client.shutdown();
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
      valid.client.shutdown();

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
      invalid.client.shutdown();
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
    client.shutdown();

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
    client.shutdown();

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

  it('emits a failed request metric when the app-server rejects a request', async () => {
    const { client } = createRpcClientFixture((message) => {
      if (message.method === 'initialize') return initializeResponse;
      return { error: { code: -32001, message: 'Server overloaded' } };
    });
    const metrics = [];
    client.on('metric', (metric) => metrics.push(metric));

    await expect(client.loadedThreads()).rejects.toThrow('Server overloaded');
    client.shutdown();

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
    expect(mapThinkingModeToCodexEffort('max')).toBe('xhigh');
    expect(mapThinkingModeToCodexEffort('ultra')).toBe('ultra');
  });

  it('preserves the interactive max effort mapping in turn params', () => {
    const params = buildTurnStartParams({
      threadId: 'thread-1',
      command: 'hello',
      model: 'gpt-5.4-codex',
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

  it('builds thread/fork params from durable thread identity', () => {
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
    const activeCodeModeCallIds = new Set();
    const code = '// @exec: {"yield_time_ms": 1000}\ntext("ok")';

    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'other',
      call_id: 'call-other',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeCodeModeCallIds)).toEqual([]);
    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-other',
      output: 'ignored',
    }, '2026-07-10T21:34:09.149Z', activeCodeModeCallIds)).toEqual([]);

    const input = convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeCodeModeCallIds);
    expect(input).toHaveLength(1);
    expect(input[0]).toBeInstanceOf(ExecToolUseMessage);
    expect(input[0]).toMatchObject({
      toolId: 'call-exec',
      code,
      language: 'javascript',
    });
    expect(activeCodeModeCallIds.has('call-exec')).toBe(true);

    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeCodeModeCallIds)).toEqual([]);

    const output = convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec',
      output: [{ type: 'input_text', text: 'ok' }],
    }, '2026-07-10T21:34:09.150Z', activeCodeModeCallIds);
    expect(output).toHaveLength(1);
    expect(output[0]).toBeInstanceOf(ToolResultMessage);
    expect(output[0]).toMatchObject({
      toolId: 'call-exec',
      content: { items: [{ type: 'input_text', text: 'ok' }] },
      isError: false,
    });
    expect(activeCodeModeCallIds.has('call-exec')).toBe(false);
    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec',
      output: 'duplicate',
    }, '2026-07-10T21:34:09.151Z', activeCodeModeCallIds)).toEqual([]);

    convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec-string',
      input: 'text("done")',
    }, '2026-07-10T21:34:09.152Z', activeCodeModeCallIds);
    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec-string',
      output: 'Script completed',
    }, '2026-07-10T21:34:09.153Z', activeCodeModeCallIds)[0]).toMatchObject({
      content: { raw: 'Script completed' },
    });
  });

  it('ignores malformed raw Exec calls', () => {
    const activeCodeModeCallIds = new Set();
    expect(convertCodexRawCodeModeItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
    }, '2026-07-10T21:34:09.149Z', activeCodeModeCallIds)).toEqual([]);
    expect(activeCodeModeCallIds.size).toBe(0);
  });

  it('normalizes only tracked raw Wait calls and outputs', () => {
    const activeCodeModeCallIds = new Set();
    const input = convertCodexRawCodeModeItem({
      type: 'function_call',
      name: 'wait',
      call_id: 'call-wait',
      arguments: '{"cell_id":"46","yield_time_ms":30000,"max_tokens":12000}',
    }, '2026-07-11T00:27:03.417Z', activeCodeModeCallIds);

    expect(input).toHaveLength(1);
    expect(input[0]).toBeInstanceOf(WaitToolUseMessage);
    expect(input[0]).toMatchObject({
      toolId: 'call-wait',
      executionId: '46',
      yieldTimeMs: 30000,
      maxTokens: 12000,
    });
    expect(activeCodeModeCallIds.has('call-wait')).toBe(true);

    const output = convertCodexRawCodeModeItem({
      type: 'function_call_output',
      call_id: 'call-wait',
      output: 'Script completed',
    }, '2026-07-11T00:27:33.417Z', activeCodeModeCallIds);

    expect(output[0]).toBeInstanceOf(ToolResultMessage);
    expect(output[0]).toMatchObject({
      toolId: 'call-wait',
      content: { raw: 'Script completed' },
      isError: false,
    });
    expect(activeCodeModeCallIds.has('call-wait')).toBe(false);
  });

  it('ignores malformed raw Wait calls', () => {
    const activeCodeModeCallIds = new Set();
    expect(convertCodexRawCodeModeItem({
      type: 'function_call',
      name: 'wait',
      call_id: 'call-wait',
      arguments: '{"yield_time_ms":30000}',
    }, '2026-07-11T00:27:03.417Z', activeCodeModeCallIds)).toEqual([]);
    expect(activeCodeModeCallIds.size).toBe(0);
  });

  it('converts app-server live item families to shared chat messages', () => {
    const items = [
      { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Hi', text_elements: [] }] },
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
    expect(messages.find((message) => message.type === 'web-search-tool-use')?.query).toBe('codex app server');
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
    }, '2026-02-21T10:01:00.000Z', new Set());

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
    }, '2026-02-21T10:01:00.000Z', new Set());

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
    }, '2026-02-21T10:01:00.000Z', new Set());

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
    }, '2026-02-21T10:01:00.000Z', new Set())).toEqual([]);
    expect(convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/reviewer',
      recipient: 'root',
      content,
    }, '2026-02-21T10:01:00.000Z', new Set())).toEqual([]);
    expect(convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/reviewer',
      recipient: '/root/other',
      content,
    }, '2026-02-21T10:01:00.000Z', new Set())).toEqual([]);

    const nestedContent = [{
      type: 'input_text',
      text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/parent/child\nPayload:\nDone',
    }];
    expect(convertCodexRawCodeModeItem({
      type: 'agent_message',
      author: '/root/parent/child',
      recipient: '/root',
      content: nestedContent,
    }, '2026-02-21T10:01:00.000Z', new Set())).toEqual([]);
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
    }, '2026-02-21T10:01:00.000Z', new Set());

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
    }, '2026-02-21T10:01:00.000Z', new Set())).toEqual([]);
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
    }, '2026-02-21T10:01:00.000Z', new Set());

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

  function createActiveGoalQueue(provider, codexGoalCommand, markUnconfirmed) {
    return new ChatExecutionCoordinator(
      tmpDir,
      {
        runAgentTurn: async () => { throw new Error('must use active delivery'); },
        submitActiveInput: (_chatId, command, options, beforeDelivery) => provider.submitActiveInput(makeRequest({
          ...options,
          agentSessionId: 'thread-1',
          command,
          codexGoalCommand,
          nativePath: null,
        }), beforeDelivery),
        abortSession: async () => false,
        isChatRunning: () => provider.isRunning('thread-1'),
        waitUntilTurnAbortable: async () => true,
      },
      {
        register: async () => {},
        discard: () => true,
        markFailed: () => true,
        markUnconfirmed,
      },
      { appendMessages: async () => ({ generationId: 'generation-1', messages: [] }) },
      () => ({
        model: 'gpt-5.4-codex',
        permissionMode: 'default',
        thinkingMode: 'medium',
        claudeThinkingMode: 'off',
        ampAgentMode: 'default',
      }),
      () => true,
    );
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });

    await expect(provider.startSession(makeRequest())).resolves.toEqual({
      agentSessionId: 'thread-1',
      nativePath,
    });
    expect(fake.startThread).toHaveBeenCalledTimes(1);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
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

  it('reports abortability only after the provider turn id is available', async () => {
    let resolveTurn;
    const turn = new Promise((resolve) => { resolveTurn = resolve; });
    let startRequested;
    const requested = new Promise((resolve) => { startRequested = resolve; });
    const fake = new FakeClient({
      startTurn: async () => {
        startRequested();
        return turn;
      },
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const onAbortable = mock(() => undefined);
    const run = provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      nativePath: null,
      onAbortable,
    }));

    await requested;
    expect(onAbortable).not.toHaveBeenCalled();
    resolveTurn({ turn: makeTurn({ status: 'inProgress', completedAt: null, durationMs: null }) });
    await run;

    expect(onAbortable).toHaveBeenCalledTimes(1);
    await expect(provider.abort('thread-1')).resolves.toBe(true);
    expect(fake.interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-1');
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.startSession(makeRequest());

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
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      nativePath: null,
    }));
    await finished;

    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const emitted = [];
    const failures = [];
    const processing = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    provider.onFailed((chatId, message) => failures.push({ chatId, message }));
    provider.onProcessing((_chatId, value) => processing.push(value));
    await provider.startSession(makeRequest());

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

    expect(emitted.map((message) => message.content)).toEqual([
      'Reconnecting... 1/5',
      'Reconnecting... 2/5',
    ]);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(processing.at(-1)).toBe(true);
    expect(failures).toEqual([]);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = new Promise((resolve) => provider.onFinished(resolve));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn() },
    });
    await finished;
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => clients.shift(), materializationTimeoutMs: 20 });
    const emitted = [];
    const failures = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    provider.onFailed((_chatId, message) => failures.push(message));

    await provider.startSession(makeRequest());
    const oldFinished = new Promise((resolve) => provider.onFinished(resolve));
    staleClient.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'old-turn' }) },
    });
    await oldFinished;
    await provider.startSession(makeRequest());

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

    expect(emitted).toEqual([]);
    expect(failures).toEqual([]);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(activeClient.shutdown).not.toHaveBeenCalled();

    const activeFinished = new Promise((resolve) => provider.onFinished(resolve));
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const emitted = [];
    const failures = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    provider.onFailed((_chatId, message) => failures.push(message));
    await provider.startSession(makeRequest());

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

    expect(emitted).toEqual([]);
    expect(failures).toEqual([]);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = new Promise((resolve) => provider.onFinished(resolve));
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
    });
    const failures = [];
    provider.onFailed((_chatId, message) => failures.push(message));
    await provider.startSession(makeRequest());

    emitCapacityFailure(fake, 'turn-1');

    await expect(retryStarted).resolves.toEqual({ threadId: 'thread-1', input: [] });
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(failures).toEqual([]);

    const finished = new Promise((resolve) => provider.onFinished(resolve));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-2' }) },
    });
    await finished;
    expect(fake.startTurn).toHaveBeenCalledTimes(2);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
    });
    const failures = [];
    provider.onFailed((_chatId, message) => failures.push(message));
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

    await expect(retryStarted).resolves.toEqual({ threadId: 'thread-1', status: 'active' });
    expect(fake.setThreadGoalStatus).toHaveBeenCalledWith('thread-1', 'active');
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(failures).toEqual([]);

    const finished = new Promise((resolve) => provider.onFinished(resolve));
    fake.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: 'turn-2', goal: makeGoal('thread-1', 'Finish the work', 'complete') },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-2' }) },
    });
    await finished;
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });

    await provider.startSession(makeRequest());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.startTurn).toHaveBeenCalledTimes(2);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = new Promise((resolve) => provider.onFinished(resolve));
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Continue through capacity recovery',
      nativePath: null,
    }))).resolves.toBe(true);
    await retryStarted.promise;

    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(fake.setThreadGoalStatus).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = new Promise((resolve) => provider.onFinished(resolve));
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });

    const running = provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'resume' },
      nativePath: null,
    }));
    await retryStarted.promise;
    await running;

    expect(fake.setThreadGoalStatus).toHaveBeenCalledTimes(2);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = new Promise((resolve) => provider.onFinished(resolve));
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
        }
        return { turn };
      },
    });
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
    });
    await provider.startSession(makeRequest());

    emitCapacityFailure(fake, 'turn-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.startTurn).toHaveBeenCalledTimes(3);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = new Promise((resolve) => provider.onFinished(resolve));
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
      capacityRetryDelay: () => Promise.resolve(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.setThreadGoalStatus).toHaveBeenCalledTimes(2);
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();

    const finished = new Promise((resolve) => provider.onFinished(resolve));
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
      const provider = new CodexAppServerRuntime({
        createClient: () => fake,
        capacityRetryDelaysMs: [25],
        capacityRetryDelay: controlledDelay.wait,
      });

      const running = provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        command: 'Deliver this before retrying',
        nativePath: null,
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

      const finished = new Promise((resolve) => provider.onFinished(resolve));
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
      const provider = new CodexAppServerRuntime({
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

      await expect(provider.submitActiveInput(makeRequest({
        agentSessionId: 'thread-1',
        command: `/goal ${control}`,
        codexGoalCommand: { kind: control },
        nativePath: null,
      }))).resolves.toBe(true);

      controlledDelay.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(goalCalls).toEqual([control === 'pause' ? 'paused' : 'clear']);
      expect(provider.isRunning('thread-1')).toBe(false);
      expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({
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

    await expect(provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0, 0],
    });
    const failed = new Promise((resolve) => provider.onFailed((chatId, message) => resolve({ chatId, message })));
    await provider.startSession(makeRequest());

    for (let attempt = 0; attempt < 4; attempt += 1) {
      emitCapacityFailure(fake, `turn-${attempt + 1}`);
      if (attempt < 3) {
        await expect(retryStarts[attempt]).resolves.toEqual({ threadId: 'thread-1', input: [] });
      }
    }

    await expect(failed).resolves.toEqual({
      chatId: 'chat-1',
      message: 'Selected model is at capacity. Please try a different model.',
    });
    expect(fake.startTurn).toHaveBeenCalledTimes(4);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      materializationTimeoutMs: 20,
      capacityRetryDelaysMs: [0, 0, 0],
    });
    const failed = new Promise((resolve) => provider.onFailed((chatId, message) => resolve({ chatId, message })));
    await provider.startSession(makeRequest());
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

    await expect(failed).resolves.toEqual({
      chatId: 'chat-1',
      message: 'Selected model is at capacity. Please try a different model.',
    });
    expect(fake.setThreadGoalStatus).toHaveBeenCalledTimes(3);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const emitted = [];
    const failed = new Promise((resolve) => provider.onFailed((chatId, message) => resolve({ chatId, message })));
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    await provider.startSession(makeRequest());

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

    await expect(failed).resolves.toEqual({ chatId: 'chat-1', message: 'Codex turn failed' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'error', content: 'Codex turn failed' });
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    await provider.startSession(makeRequest());

    fake.emit('notification', {
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call-exec-1',
          input: 'const value = 1; text(value);',
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

    expect(emitted.map((message) => message.type)).toEqual([
      'exec-tool-use',
      'tool-result',
      'wait-tool-use',
      'tool-result',
    ]);
    expect(emitted[0]).toMatchObject({
      toolId: 'call-exec-1',
      code: 'const value = 1; text(value);',
      language: 'javascript',
    });
    expect(emitted[1]).toMatchObject({
      toolId: 'call-exec-1',
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    await provider.startSession(makeRequest());

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
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    const finished = new Promise((resolve) => provider.onFinished(resolve));
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Keep the session active' },
      nativePath: null,
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

    expect(emitted.map((message) => message.type)).toEqual(['wait-tool-use']);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake, materializationTimeoutMs: 20 });

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
          role: 'user',
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
      const provider = new CodexAppServerRuntime({ createClient: () => fake });
      const emitted = [];
      provider.onMessages((_chatId, messages) => emitted.push(...messages));
      await provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        codexGoalCommand: { kind: 'set', objective: 'Replacement work' },
        nativePath: null,
      }));

      expect(fake.setThreadGoal).not.toHaveBeenCalled();
      expect(fake.clearThreadGoal).not.toHaveBeenCalled();
      expect(emitted.at(-1)?.content).toContain('/goal replace <objective>');
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
    }));

    expect(calls).toEqual([
      'clear',
      { objective: 'Replacement work', status: 'active' },
      { objective: 'Existing work', status: 'paused', tokenBudget: 50_000 },
    ]);
    expect(fake.getThreadGoal).toHaveBeenCalledTimes(2);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(emitted.at(-1)?.content).toContain('replacement rejected');
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));

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
    await finished;

    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
    }));

    expect(fake.getThreadGoal).toHaveBeenCalledTimes(2);
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
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('finishes cleanly when replacement and rollback both fail', async () => {
    const previous = makeGoal('thread-1', 'Existing work', 'blocked');
    let getCalls = 0;
    const fake = new FakeClient({
      getThreadGoal: async () => ({ goal: getCalls++ === 0 ? previous : null }),
      clearThreadGoal: async () => ({ cleared: true }),
      setThreadGoal: async () => { throw new Error('goal set unavailable'); },
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'replace', objective: 'Replacement work' },
      nativePath: null,
    }));

    expect(fake.setThreadGoal).toHaveBeenCalledTimes(2);
    expect(fake.getThreadGoal).toHaveBeenCalledTimes(2);
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('reports the current Codex goal without starting a turn', async () => {
    const fake = new FakeClient({
      getThreadGoal: async (threadId) => ({
        goal: makeGoal(threadId, 'Ship the feature'),
      }),
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal',
      codexGoalCommand: { kind: 'status' },
      nativePath: null,
    }));

    expect(fake.getThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(true);
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(emitted.map((message) => message.content)).toEqual([
      'Goal\nStatus: active\nObjective: Ship the feature\nTime used: 0s\nTokens used: 0\n\nCommands: /goal edit <objective>, /goal pause, /goal clear',
    ]);
  });

  it('clears the current Codex goal without starting a turn', async () => {
    const fake = new FakeClient({
      clearThreadGoal: async () => ({ cleared: true }),
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal clear',
      codexGoalCommand: { kind: 'clear' },
      nativePath: null,
    }));
    await finished;

    expect(fake.clearThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(emitted.map((message) => message.content)).toEqual(['Codex goal cleared.']);
  });

  it('pauses the current Codex goal without starting a turn', async () => {
    const fake = new FakeClient({
      setThreadGoalStatus: async (threadId, status) => ({ goal: makeGoal(threadId, 'Ship the feature', status) }),
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal pause',
      codexGoalCommand: { kind: 'pause' },
      nativePath: null,
    }));
    await finished;

    expect(fake.setThreadGoalStatus).toHaveBeenCalledWith('thread-1', 'paused');
    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(emitted.map((message) => message.content)).toEqual([
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal resume',
      codexGoalCommand: { kind: 'resume' },
      nativePath: null,
    }));
    await finished;

    expect(fake.startTurn).not.toHaveBeenCalled();
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(emitted.at(-1)?.content).toContain('Codex goal updated.');
    expect(emitted.at(-1)?.content).toContain('Ship the feature');
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
      const provider = new CodexAppServerRuntime({ createClient: () => fake });

      await provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        command: `/goal ${control}`,
        codexGoalCommand: { kind: control },
        nativePath: null,
      }));

      expect(calls).toEqual(['resume', 'get', control]);
      expect(provider.isRunning('thread-1')).toBe(false);
      expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'pause' },
      nativePath: null,
    }));

    expect(emitted.at(-1)?.content).toContain('Codex goal paused.');
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
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'clear' },
      nativePath: null,
    }));

    expect(emitted.at(-1)?.content).toBe('Codex goal cleared.');
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
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Continue after approval',
      nativePath: null,
    }));

    const request = emitted.find((message) => message instanceof PermissionRequestMessage);
    expect(request).toBeTruthy();
    expect(fake.respond).not.toHaveBeenCalled();
    expect(fake.getThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(fake.steerTurn).toHaveBeenCalledWith(expect.objectContaining({
      expectedTurnId: 'automatic-turn',
    }));
    await provider.resolvePermission(request.permissionRequestId, { allow: true });
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'status' },
      nativePath: null,
    }));

    expect(emitted.at(-1)?.content).toContain('Status: complete');
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const processing = [];
    provider.onProcessing((_chatId, value) => processing.push(value));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Do not dispatch after terminal replay',
      nativePath: null,
    }));

    expect(provider.isRunning('thread-1')).toBe(true);
    expect(processing).toContain(true);
    expect(fake.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Do not dispatch after terminal replay', text_elements: [] }],
    }));
    expect(fake.steerTurn).not.toHaveBeenCalled();
    expect(fake.shutdown).not.toHaveBeenCalled();
  });

  it('settles goal-turn waiters immediately when sessions terminate', async () => {
    for (const termination of ['finish', 'abort', 'exit']) {
      let setCalled;
      const ready = new Promise((resolve) => { setCalled = resolve; });
      const fake = new FakeClient({
        getThreadGoal: async () => ({ goal: null }),
        setThreadGoal: async (threadId, params) => {
          setCalled();
          return { goal: makeGoal(threadId, params.objective) };
        },
      });
      const provider = new CodexAppServerRuntime({ createClient: () => fake });
      const emitted = [];
      provider.onMessages((_chatId, messages) => emitted.push(...messages));
      const running = provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        codexGoalCommand: { kind: 'set', objective: `Wait for ${termination}` },
        nativePath: null,
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
      expect(emitted.some((message) => String(message.content).includes('timed out waiting'))).toBe(false);
    }
  });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal edit Better objective',
      codexGoalCommand: { kind: 'edit', objective: 'Better objective' },
      nativePath: null,
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'edit', objective: 'Better objective' },
      nativePath: null,
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal edit',
      codexGoalCommand: { kind: 'edit', objective: null },
      nativePath: null,
    }));
    await finished;

    expect(emitted.at(-1)?.content).toBe('Usage: /goal edit <objective>');
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Finish all rounds' },
      nativePath: null,
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
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
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

  it('reconciles active input through the delivered payload and native history loader', async () => {
    const content = 'Preserve active input & literal markup <exactly>';
    const nativePath = path.join(tmpDir, 'active-input.jsonl');
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: () => loadCodexChatMessages(nativePath),
      getRetainedHistoryMessages: () => [],
    });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
      agentSessionId: 'thread-1',
      command: content,
      clientMessageId: 'message-steer',
      nativePath,
    }), async () => {
      await pendingInputs.register('chat-1', content, {
        clientRequestId: 'request-steer',
        clientMessageId: 'message-steer',
        createdAt: '2026-06-01T00:00:00.000Z',
      });
    })).resolves.toBe(true);

    expect(pendingInputs.listForChat('chat-1')).toHaveLength(1);
    expect(await loadCodexChatMessages(nativePath)).toMatchObject([
      { type: 'user-message', content },
    ]);
    await pendingInputs.reconcileNativeHistory('chat-1');
    expect(pendingInputs.listForChat('chat-1')).toEqual([]);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    const queue = new ChatExecutionCoordinator(
      tmpDir,
      {
        runAgentTurn: async () => { throw new Error('must use active delivery'); },
        submitActiveInput: (_chatId, command, options, beforeDelivery) => provider.submitActiveInput(makeRequest({
          ...options,
          agentSessionId: 'thread-1',
          command,
          nativePath: null,
        }), beforeDelivery),
        abortSession: async () => false,
        isChatRunning: () => provider.isRunning('thread-1'),
        waitUntilTurnAbortable: async () => true,
      },
      {
        register: async () => { registered = true; },
        discard: () => true,
        markFailed: () => true,
      },
      {
        appendMessages: async () => ({ generationId: 'generation-1', messages: [] }),
      },
      () => ({
        model: 'gpt-5.4-codex',
        permissionMode: 'default',
        thinkingMode: 'medium',
        claudeThinkingMode: 'off',
        ampAgentMode: 'default',
      }),
      () => true,
    );

    const result = await queue.deliverActiveInput('chat-1', 'Steer from the queue', {
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    const markUnconfirmed = mock(() => true);
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    const queue = createActiveGoalQueue(provider, { kind: 'pause' }, markUnconfirmed);

    await expect(queue.deliverActiveInput('chat-1', '/goal pause', {
      clientRequestId: 'request-goal-failure',
      clientMessageId: 'message-goal-failure',
      turnId: 'turn-goal-failure',
    })).rejects.toMatchObject({
      deliveryAccepted: true,
      retryable: false,
      cause: expect.objectContaining({ message: 'goal status unavailable' }),
    });

    expect(markUnconfirmed).toHaveBeenCalledWith('chat-1', 'request-goal-failure');
    expect(emitted.at(-1)?.content).toBe('Codex error: goal status unavailable');
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const markUnconfirmed = mock(() => true);
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });
    const queue = createActiveGoalQueue(provider, { kind: 'resume' }, markUnconfirmed);

    const delivery = queue.deliverActiveInput('chat-1', '/goal resume', {
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
    expect(markUnconfirmed).toHaveBeenCalledWith('chat-1', 'request-goal-cancelled');
  });

  it('declines active input without accepting its user row after the Codex session ends', async () => {
    const nativePath = path.join(tmpDir, 'ended-before-acceptance.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: makeTurn({ id: 'turn-1', status: 'inProgress' }) };
      },
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));
    await provider.startSession(makeRequest());
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await finished;
    let accepted = false;

    await expect(provider.submitActiveInput(makeRequest({
      agentSessionId: 'thread-1',
      command: 'too late',
      nativePath: null,
    }), async () => { accepted = true; })).resolves.toBe(false);

    expect(accepted).toBe(false);
    expect(fake.steerTurn).not.toHaveBeenCalled();
  });

  it('keeps compact and other unmanaged turns on the persisted queue path', async () => {
    const fake = new FakeClient();
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.compact(makeRequest({ agentSessionId: 'thread-1', nativePath: null }));
    let accepted = false;

    await expect(provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({
      createClient: () => fake,
      capacityRetryDelaysMs: [25],
      capacityRetryDelay: controlledDelay.wait,
    });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
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
      const provider = new CodexAppServerRuntime({ createClient: () => fake });
      await provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
        nativePath: null,
      }));
      let accepted = false;

      const delivery = provider.submitActiveInput(makeRequest({
        agentSessionId: 'thread-1',
        command: `Deliver after ${turnKind}`,
        nativePath: null,
      }), async () => { accepted = true; });
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await expect(provider.submitActiveInput(makeRequest({
      agentSessionId: 'thread-1',
      command: 'Steer the fresh turn',
      nativePath: null,
    }))).resolves.toBe(true);

    expect(steeredTurnIds).toEqual(['old-turn', 'boundary-turn', 'fresh-turn']);
    expect(fake.startTurn).not.toHaveBeenCalled();
  });

  it('declines active delivery before acceptance when a terminal finish is pending', async () => {
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    const first = provider.submitActiveInput(makeRequest({
      agentSessionId: 'thread-1',
      command: 'First input',
      nativePath: null,
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
    });
    await expect(first).rejects.toThrow('terminal failure');
    let accepted = false;
    await expect(provider.submitActiveInput(makeRequest({
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));

    await provider.submitActiveInput(makeRequest({
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
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Clear safely' },
      nativePath: null,
    }));

    await provider.submitActiveInput(makeRequest({
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
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });

    await expect(provider.submitActiveInput(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal pause',
      codexGoalCommand: { kind: 'pause' },
      nativePath: null,
    }))).resolves.toBe(true);

    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      codexGoalCommand: { kind: 'set', objective: 'Long-running work' },
      nativePath: null,
    }));
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'goal-turn' }) },
    });

    await expect(provider.submitActiveInput(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal clear',
      codexGoalCommand: { kind: 'clear' },
      nativePath: null,
    }))).resolves.toBe(true);

    expect(emitted.at(-1)?.content).toBe('No Codex goal was set.');
    expect(provider.isRunning('thread-1')).toBe(false);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const finished = new Promise((resolve) => provider.onFinished(resolve));
    await provider.startSession(makeRequest({
      codexGoalCommand: { kind: 'set', objective: 'Inspect attachments' },
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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

  it('loads paginated history through full canonical app-server items', async () => {
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
        data: [makeTurn({ items: [
          { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'canonical prompt' }] },
          { type: 'agentMessage', id: 'assistant-1', text: 'canonical answer', phase: null, memoryCitation: null },
        ] })],
        nextCursor: null,
        backwardsCursor: null,
      }),
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
      itemsView: 'full',
    }));
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('fails closed before loading an inherited paginated history', async () => {
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
    const fake = new FakeClient();
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

    await expect(provider.loadMessages({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath,
      projectPath: '/repo',
    })).rejects.toMatchObject({
      code: 'OPERATION_UNSUPPORTED',
      details: { operation: 'load-history', historyMode: 'paginated', provider: 'codex' },
    });
    expect(fake.listThreadTurns).not.toHaveBeenCalled();
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

    const resolvedPath = await provider.resolveNativePath({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });

    expect(fake.listThreads).toHaveBeenCalledWith(expect.objectContaining({ useStateDbOnly: false }));
    expect(resolvedPath).toBe(nativePath);
  });

  it('surfaces thread/list failures during native path reconciliation', async () => {
    const fake = new FakeClient({
      listThreads: async () => {
        throw new Error('app-server unavailable');
      },
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

    await expect(provider.resolveNativePath({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    })).rejects.toThrow('app-server unavailable');

  });

  it('loads previews from native Codex JSONL', async () => {
    const nativePath = path.join(tmpDir, 'preview-thread.jsonl');
    await writeJsonl(nativePath, [
      {
        type: 'session_meta',
        timestamp: '2026-02-21T09:59:59.000Z',
        payload: { id: 'thread-1', history_mode: 'legacy' },
      },
      {
        type: 'event_msg',
        timestamp: '2026-02-21T10:00:00.000Z',
        payload: { type: 'user_message', message: 'Preview prompt' },
      },
      {
        type: 'response_item',
        timestamp: '2026-02-21T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Preview answer' }],
        },
      },
    ]);
    const fake = new FakeClient();
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

    const preview = await provider.getPreview({
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath,
      projectPath: '/repo',
    });

    expect(preview.firstMessage).toBe('Preview prompt');
    expect(preview.lastMessage).toBe('Preview answer');
    expect(fake.connect).toHaveBeenCalledTimes(0);
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
    const provider = new CodexAppServerRuntime({
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.startSession(makeRequest());
    const session = {
      provider: 'codex',
      agentSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    };
    const finished = new Promise((resolve) => provider.onFinished(resolve));

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    const finished = new Promise((resolve) => provider.onFinished(resolve));
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.startSession(makeRequest());
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await finished;

    expect(emitted).toEqual([]);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    const finished = new Promise((resolve) => provider.onFinished(resolve));
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.startSession(makeRequest());
    fake.emit('notification', {
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: liveItem },
    });
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: makeTurn({ id: 'turn-1' }) },
    });
    await finished;

    expect(emitted.map((message) => message.content)).toEqual(['Already emitted']);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });

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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    await provider.startSession(makeRequest());

    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    fake.emit('serverRequest', {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'ls' },
    });

    const request = emitted.find((message) => message instanceof PermissionRequestMessage);
    expect(request).toBeTruthy();
    await provider.resolvePermission(request.permissionRequestId, { allow: true });

    expect(fake.respond).toHaveBeenCalledWith(7, { decision: 'accept' });
    expect(emitted.some((message) => message instanceof PermissionResolvedMessage)).toBe(true);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.startSession(makeRequest({ permissionMode: 'manualBypass' }));
    fake.emit('serverRequest', {
      id: 9,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'ls' },
    });

    expect(fake.respond).toHaveBeenCalledWith(9, { decision: 'accept' });
    expect(emitted.some((message) => message instanceof PermissionRequestMessage)).toBe(false);
    expect(emitted.some((message) => message instanceof PermissionResolvedMessage)).toBe(false);
  });

  it('applies live manual bypass updates to app-server approvals', async () => {
    const nativePath = path.join(tmpDir, 'manual-bypass-updated-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } };
      },
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    const started = await provider.startSession(makeRequest());
    provider.updateSessionSettings(started.agentSessionId, { permissionMode: 'manualBypass' });
    fake.emit('serverRequest', {
      id: 10,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'ls' },
    });

    expect(fake.respond).toHaveBeenCalledWith(10, { decision: 'accept' });
    expect(emitted.some((message) => message instanceof PermissionRequestMessage)).toBe(false);
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
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.startSession(makeRequest());
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

    expect(emitted.map((message) => message.type)).toEqual(['assistant-message']);
    expect(emitted[0].content).toBe('Hi there');
  });
});
