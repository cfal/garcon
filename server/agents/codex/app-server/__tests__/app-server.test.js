import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CodexSubagentToolUseMessage, PermissionRequestMessage, PermissionResolvedMessage } from '../../../../../common/chat-types.js';
import { buildApprovalResponse, createPendingApproval } from '../approvals.ts';
import { CodexAppServerClient } from '../client.ts';
import { convertCodexAppServerItem, convertCodexAppServerLiveItem } from '../converter.ts';
import { waitForMaterializedThread } from '../durability.ts';
import { CodexAppServerRuntime } from '../runtime.ts';
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
    this.listThreads = mock(script.listThreads ?? (async () => ({ data: [], nextCursor: null, backwardsCursor: null })));
    this.loadedThreads = mock(script.loadedThreads ?? (async () => ({ data: [] })));
    this.unsubscribeThread = mock(script.unsubscribeThread ?? (async () => ({ status: 'notSubscribed' })));
    this.startTurn = mock(script.startTurn ?? (async () => ({ turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } })));
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
