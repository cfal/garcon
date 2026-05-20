import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PermissionRequestMessage, PermissionResolvedMessage } from '../../../common/chat-types.js';
import { buildApprovalResponse, createPendingApproval } from '../codex-app-server/approvals.ts';
import { convertCodexAppServerLiveItem, convertCodexAppServerThread } from '../codex-app-server/converter.ts';
import { waitForMaterializedThread } from '../codex-app-server/durability.ts';
import { CodexAppServerProvider } from '../codex-app-server/provider.ts';
import { buildThreadStartParams, buildTurnStartParams } from '../codex-app-server/request-builders.ts';

function makeRequest(overrides = {}) {
  return {
    chatId: 'chat-1',
    command: 'hello',
    projectPath: '/repo',
    model: 'gpt-5.4-codex',
    permissionMode: 'default',
    thinkingMode: 'think-hard',
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

class FakeClient extends EventEmitter {
  constructor(script = {}) {
    super();
    this.script = script;
    this.startThread = mock(script.startThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.resumeThread = mock(script.resumeThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.forkThread = mock(script.forkThread ?? (async () => ({ thread: makeThread(), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' })));
    this.readThread = mock(script.readThread ?? (async () => ({ thread: makeThread() })));
    this.listThreads = mock(script.listThreads ?? (async () => ({ data: [], nextCursor: null, backwardsCursor: null })));
    this.startTurn = mock(script.startTurn ?? (async () => ({ turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } })));
    this.interruptTurn = mock(script.interruptTurn ?? (async () => ({})));
    this.connect = mock(script.connect ?? (async () => ({ userAgent: 'codex', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' })));
    this.respond = mock();
    this.reject = mock();
    this.shutdown = mock();
  }
}

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
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      config: { model_provider: 'openai' },
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
      thinkingMode: 'think-harder',
    });

    expect(params.input).toEqual([
      { type: 'text', text: 'run this', text_elements: [] },
      { type: 'localImage', path: '/tmp/a.png' },
    ]);
    expect(params.effort).toBe('high');
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
  it('converts app-server thread items to shared chat messages', () => {
    const thread = makeThread({
      turns: [{
        id: 'turn-1',
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1_700_000_000_000,
        completedAt: 1_700_000_001_000,
        durationMs: 1000,
        items: [
          { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Hi', text_elements: [] }] },
          { type: 'reasoning', id: 'r1', summary: ['thinking'], content: [] },
          { type: 'agentMessage', id: 'a1', text: 'Hello', phase: null, memoryCitation: null },
          { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/repo', processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: 'ok', exitCode: 0, durationMs: 12 },
          { type: 'fileChange', id: 'f1', changes: [{ path: '/repo/a.txt', kind: 'update' }], status: 'completed' },
          { type: 'webSearch', id: 'w1', query: 'codex app server', action: null },
        ],
      }],
    });

    expect(convertCodexAppServerThread(thread).map((message) => message.type)).toEqual([
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
  });

  it('suppresses echoed user messages on the live notification path', () => {
    expect(convertCodexAppServerLiveItem({
      type: 'userMessage',
      id: 'u1',
      content: [{ type: 'text', text: 'Hi', text_elements: [] }],
    })).toEqual([]);
  });

  it('uses generic structured tool-use messages for dynamic and MCP item families', () => {
    const thread = makeThread({
      turns: [{
        id: 'turn-1',
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1_700_000_000_000,
        completedAt: 1_700_000_001_000,
        durationMs: 1000,
        items: [
          { type: 'dynamicToolCall', id: 'd1', namespace: 'app', tool: 'custom_lookup', arguments: { q: 'test' }, status: 'completed', contentItems: [], success: true, durationMs: 10 },
          { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'list_prs', status: 'completed', arguments: { state: 'open' }, result: { content: [] }, error: null, durationMs: 10 },
        ],
      }],
    });

    expect(convertCodexAppServerThread(thread).map((message) => message.type)).toEqual([
      'external-tool-use',
      'tool-result',
      'mcp-tool-use',
      'tool-result',
    ]);
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

describe('CodexAppServerProvider', () => {
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
    const provider = new CodexAppServerProvider({ createClient: () => fake, materializationTimeoutMs: 20 });

    await expect(provider.startSession(makeRequest())).resolves.toEqual({
      providerSessionId: 'thread-1',
      nativePath,
    });
    expect(fake.startThread).toHaveBeenCalledTimes(1);
    expect(fake.startTurn).toHaveBeenCalledTimes(1);
    expect(provider.isRunning('thread-1')).toBe(true);
  });

  it('loads history through thread/read', async () => {
    const fake = new FakeClient({
      readThread: async () => ({
        thread: makeThread({
          turns: [{
            id: 'turn-1',
            itemsView: 'full',
            status: 'completed',
            error: null,
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_001_000,
            durationMs: 1000,
            items: [{ type: 'agentMessage', id: 'a1', text: 'Loaded', phase: null, memoryCitation: null }],
          }],
        }),
      }),
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });

    const messages = await provider.loadMessages({
      provider: 'codex',
      providerSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });

    expect(fake.readThread).toHaveBeenCalledWith('thread-1', true);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Loaded');
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
      readThread: async () => {
        throw new Error('thread not loaded: thread-1');
      },
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });

    const resolvedPath = await provider.resolveNativePath({
      provider: 'codex',
      providerSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });

    expect(fake.listThreads).toHaveBeenCalledWith(expect.objectContaining({ useStateDbOnly: false }));
    expect(fake.readThread).toHaveBeenCalledTimes(0);
    expect(resolvedPath).toBe(nativePath);
  });

  it('surfaces thread/list failures during native path reconciliation', async () => {
    const fake = new FakeClient({
      listThreads: async () => {
        throw new Error('app-server unavailable');
      },
      readThread: async () => {
        throw new Error('thread not loaded: thread-1');
      },
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });

    await expect(provider.resolveNativePath({
      provider: 'codex',
      providerSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    })).rejects.toThrow('app-server unavailable');

    expect(fake.readThread).toHaveBeenCalledTimes(0);
  });

  it('loads previews through summary thread/read', async () => {
    const fake = new FakeClient({
      readThread: async () => ({
        thread: makeThread({ preview: 'Preview text' }),
      }),
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });

    const preview = await provider.getPreview({
      provider: 'codex',
      providerSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });

    expect(fake.readThread).toHaveBeenCalledWith('thread-1', false);
    expect(preview.firstMessage).toBe('Preview text');
  });

  it('loads previews from the thread/list cache when available', async () => {
    const fake = new FakeClient({
      listThreads: async () => ({
        data: [makeThread({ id: 'thread-1', preview: 'Listed preview' })],
        nextCursor: null,
        backwardsCursor: null,
      }),
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });

    const preview = await provider.getPreview({
      provider: 'codex',
      providerSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });

    expect(preview.firstMessage).toBe('Listed preview');
    expect(fake.listThreads).toHaveBeenCalledWith(expect.objectContaining({ useStateDbOnly: true }));
    expect(fake.readThread).toHaveBeenCalledTimes(0);
  });

  it('clears thread/list preview caches when a session finishes', async () => {
    const nativePath = path.join(tmpDir, 'finished-thread.jsonl');
    let preview = 'Before finish';
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } };
      },
      listThreads: async () => ({
        data: [makeThread({ id: 'thread-1', preview })],
        nextCursor: null,
        backwardsCursor: null,
      }),
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });
    await provider.startSession(makeRequest());
    const session = {
      provider: 'codex',
      providerSessionId: 'thread-1',
      nativePath,
      projectPath: '/repo',
    };

    const before = await provider.getPreview(session);
    preview = 'After finish';
    fake.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { status: 'completed', error: null } },
    });
    const after = await provider.getPreview(session);

    expect(before.firstMessage).toBe('Before finish');
    expect(after.firstMessage).toBe('After finish');
    expect(fake.listThreads).toHaveBeenCalledTimes(2);
  });

  it('serializes utility app-server reads', async () => {
    let releaseFirst;
    const readStarts = [];
    const fake = new FakeClient({
      readThread: async (threadId, includeTurns) => {
        readStarts.push({ threadId, includeTurns });
        if (readStarts.length === 1) {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { thread: makeThread({ id: threadId, preview: threadId }) };
      },
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });

    const first = provider.getPreview({
      provider: 'codex',
      providerSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });
    await tick();

    const second = provider.getPreview({
      provider: 'codex',
      providerSessionId: 'thread-2',
      nativePath: null,
      projectPath: '/repo',
    });
    await tick();

    expect(readStarts).toEqual([{ threadId: 'thread-1', includeTurns: false }]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(readStarts).toEqual([
      { threadId: 'thread-1', includeTurns: false },
      { threadId: 'thread-2', includeTurns: false },
    ]);
  });

  it('retries retryable utility app-server overload responses', async () => {
    let attempts = 0;
    const fake = new FakeClient({
      readThread: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('Server overloaded; retry later.'), { code: -32001 });
        }
        return { thread: makeThread({ preview: 'Recovered preview' }) };
      },
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });

    const preview = await provider.getPreview({
      provider: 'codex',
      providerSessionId: 'thread-1',
      nativePath: null,
      projectPath: '/repo',
    });

    expect(attempts).toBe(2);
    expect(preview.firstMessage).toBe('Recovered preview');
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
    const provider = new CodexAppServerProvider({ createClient: () => fake });
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

  it('does not re-emit the submitted prompt when app-server echoes userMessage items', async () => {
    const nativePath = path.join(tmpDir, 'live-user-echo-thread.jsonl');
    const fake = new FakeClient({
      startThread: async () => ({ thread: makeThread({ id: 'thread-1', path: nativePath }), model: 'gpt', modelProvider: 'openai', serviceTier: null, cwd: '/repo' }),
      startTurn: async () => {
        await fs.writeFile(nativePath, '{}\n');
        return { turn: { id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1_700_000_000_000, completedAt: null, durationMs: null } };
      },
    });
    const provider = new CodexAppServerProvider({ createClient: () => fake });
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
