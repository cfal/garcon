import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CodexSubagentToolUseMessage, ExecToolUseMessage, PermissionRequestMessage, PermissionResolvedMessage, ToolResultMessage } from '../../../../../common/chat-types.js';
import { buildApprovalResponse, createPendingApproval } from '../approvals.ts';
import { CodexAppServerClient } from '../client.ts';
import { convertCodexAppServerItem, convertCodexAppServerLiveItem, convertCodexRawExecItem } from '../converter.ts';
import { waitForMaterializedThread } from '../durability.ts';
import { CodexAppServerRuntime } from '../runtime.ts';
import { QueueManager } from '../../../../queue.ts';
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
    this.getThreadGoal = mock(script.getThreadGoal ?? (async (threadId) => ({ goal: makeGoal(threadId, 'Ship the feature') })));
    this.clearThreadGoal = mock(script.clearThreadGoal ?? (async () => ({ cleared: true })));
    this.listThreads = mock(script.listThreads ?? (async () => ({ data: [], nextCursor: null, backwardsCursor: null })));
    this.loadedThreads = mock(script.loadedThreads ?? (async () => ({ data: [] })));
    this.unsubscribeThread = mock(script.unsubscribeThread ?? (async () => ({ status: 'notSubscribed' })));
    this.startTurn = mock(script.startTurn ?? (async () => ({ turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } })));
    this.steerTurn = mock(script.steerTurn ?? (async ({ expectedTurnId }) => ({ turnId: expectedTurnId })));
    this.interruptTurn = mock(script.interruptTurn ?? (async () => ({})));
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
    const activeExecCallIds = new Set();
    const code = '// @exec: {"yield_time_ms": 1000}\ntext("ok")';

    expect(convertCodexRawExecItem({
      type: 'custom_tool_call',
      name: 'other',
      call_id: 'call-other',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeExecCallIds)).toEqual([]);
    expect(convertCodexRawExecItem({
      type: 'custom_tool_call_output',
      call_id: 'call-other',
      output: 'ignored',
    }, '2026-07-10T21:34:09.149Z', activeExecCallIds)).toEqual([]);

    const input = convertCodexRawExecItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeExecCallIds);
    expect(input).toHaveLength(1);
    expect(input[0]).toBeInstanceOf(ExecToolUseMessage);
    expect(input[0]).toMatchObject({
      toolId: 'call-exec',
      code,
      language: 'javascript',
    });
    expect(activeExecCallIds.has('call-exec')).toBe(true);

    expect(convertCodexRawExecItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
      input: code,
    }, '2026-07-10T21:34:09.149Z', activeExecCallIds)).toEqual([]);

    const output = convertCodexRawExecItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec',
      output: [{ type: 'input_text', text: 'ok' }],
    }, '2026-07-10T21:34:09.150Z', activeExecCallIds);
    expect(output).toHaveLength(1);
    expect(output[0]).toBeInstanceOf(ToolResultMessage);
    expect(output[0]).toMatchObject({
      toolId: 'call-exec',
      content: { items: [{ type: 'input_text', text: 'ok' }] },
      isError: false,
    });
    expect(activeExecCallIds.has('call-exec')).toBe(false);
    expect(convertCodexRawExecItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec',
      output: 'duplicate',
    }, '2026-07-10T21:34:09.151Z', activeExecCallIds)).toEqual([]);

    convertCodexRawExecItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec-string',
      input: 'text("done")',
    }, '2026-07-10T21:34:09.152Z', activeExecCallIds);
    expect(convertCodexRawExecItem({
      type: 'custom_tool_call_output',
      call_id: 'call-exec-string',
      output: 'Script completed',
    }, '2026-07-10T21:34:09.153Z', activeExecCallIds)[0]).toMatchObject({
      content: { raw: 'Script completed' },
    });
  });

  it('ignores malformed raw Exec calls', () => {
    const activeExecCallIds = new Set();
    expect(convertCodexRawExecItem({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-exec',
    }, '2026-07-10T21:34:09.149Z', activeExecCallIds)).toEqual([]);
    expect(activeExecCallIds.size).toBe(0);
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

  it('streams raw Exec calls and their paired outputs through the shared contract', async () => {
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

    expect(emitted.map((message) => message.type)).toEqual(['exec-tool-use', 'tool-result']);
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
  });

  it('clears unmatched raw Exec calls at an automatic goal turn boundary', async () => {
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
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call-stale',
          input: 'text("waiting")',
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
          type: 'custom_tool_call_output',
          call_id: 'call-stale',
          output: 'late output',
        },
      },
    });

    expect(emitted.map((message) => message.type)).toEqual(['exec-tool-use']);
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

  it('rejects replacing an unfinished goal unless replacement is explicit', async () => {
    for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited']) {
      const fake = new FakeClient({
        getThreadGoal: async (threadId) => ({ goal: makeGoal(threadId, 'Existing work', status) }),
      });
      const provider = new CodexAppServerRuntime({ createClient: () => fake });
      const emitted = [];
      provider.onMessages((_chatId, messages) => emitted.push(...messages));
      const finished = new Promise((resolve) => provider.onFinished(resolve));

      await provider.runTurn(makeRequest({
        agentSessionId: 'thread-1',
        codexGoalCommand: { kind: 'set', objective: 'Replacement work' },
        nativePath: null,
      }));
      await finished;

      expect(fake.setThreadGoal).not.toHaveBeenCalled();
      expect(fake.clearThreadGoal).not.toHaveBeenCalled();
      expect(emitted.at(-1)?.content).toContain('/goal replace <objective>');
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

  it('reports the current Codex goal without starting a turn', async () => {
    const fake = new FakeClient({
      getThreadGoal: async (threadId) => ({
        goal: makeGoal(threadId, 'Ship the feature'),
      }),
    });
    const provider = new CodexAppServerRuntime({ createClient: () => fake });
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));
    const finished = new Promise((resolve) => provider.onFinished(resolve));

    await provider.runTurn(makeRequest({
      agentSessionId: 'thread-1',
      command: '/goal',
      codexGoalCommand: { kind: 'status' },
      nativePath: null,
    }));
    await finished;

    expect(fake.getThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(fake.startTurn).not.toHaveBeenCalled();
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
    expect(fake.getThreadGoal).not.toHaveBeenCalled();
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
    const queue = new QueueManager(
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
    );

    const result = await queue.enqueueChat('chat-1', 'Steer from the queue', {
      clientRequestId: 'request-queue',
      clientMessageId: 'message-queue',
    });

    expect(result.handledActive).toBe(true);
    expect(result.queue.entries).toEqual([]);
    expect(fake.steerTurn).toHaveBeenCalledWith(expect.objectContaining({
      expectedTurnId: 'goal-turn',
      clientUserMessageId: 'message-queue',
    }));
    expect(fake.resumeThread).toHaveBeenCalledTimes(1);
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
      params: { threadId: 'thread-1', turn: { status: 'completed', error: null } },
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
