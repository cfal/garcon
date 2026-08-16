// Permission flow tests for OpenCodeRuntime (V2-only).
// Tests permission extraction, decision mapping, guard paths, and the full
// permission lifecycle through the SSE event stream.

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  mapPermissionDecision,
  extractPermissionRequest,
  mapPermissionMode,
  OPENCODE_PERMISSION_KEYS,
} from '../permissions.js';
import { convertOpencodePermissionTool } from '../permission-tool-converter.js';
import { EnterPlanModeToolUseMessage, RequestPermissionsToolUseMessage, UnknownToolUseMessage } from '@garcon/common/chat-types';

function collectOperation(runId) {
  const events = [];
  return {
    events,
    operation: {
      runId,
      publish(event) {
        events.push(event);
      },
    },
  };
}

function createAsyncEventStream(promptHarness) {
  const events = [{ payload: { id: 'evt_connected', type: 'server.connected', properties: {} } }];
  const waiters = [];
  let closed = false;

  function flushWaiters() {
    for (const resolve of waiters.splice(0)) {
      resolve();
    }
  }

  return {
    push(event) {
      events.push(event);
      flushWaiters();
      promptHarness?.observe(event);
    },
    close() {
      closed = true;
      flushWaiters();
    },
    async *stream() {
      while (true) {
        if (events.length > 0) {
          yield events.shift();
          continue;
        }
        if (closed) return;
        await new Promise((resolve) => {
          waiters.push(resolve);
        });
      }
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createPromptHarness(promptAsync) {
  const requestsByPart = new Map();
  const requestsByMessage = new Map();
  return {
    prompt(...args) {
      void promptAsync(...args);
      const [input, options] = args;
      const response = deferred();
      const partId = input.parts[0].id;
      requestsByPart.set(partId, response);
      const abort = () => {
        requestsByPart.delete(partId);
        response.reject(options.signal.reason ?? new Error('OpenCode prompt request aborted'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
      return response.promise;
    },
    observe(envelope) {
      const event = envelope.payload;
      if (event?.type === 'message.part.updated') {
        const part = event.properties?.part;
        const operationPartId = part?.metadata?.garcon_operation_part_id ?? part?.id;
        const request = requestsByPart.get(operationPartId);
        if (request && typeof part?.messageID === 'string') {
          requestsByMessage.set(part.messageID, request);
        }
        return;
      }
      const info = event?.type === 'message.updated' ? event.properties?.info : null;
      if (typeof info?.time?.completed !== 'number') return;
      const request = requestsByMessage.get(info.parentID);
      if (request) setImmediate(() => request.resolve({ data: { info, parts: [] } }));
    },
  };
}

async function* neverEndingStream() {
  yield { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
  await new Promise(() => {});
}

async function waitForMockCall(fn) {
  await waitFor(() => fn.mock.calls.length > 0);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

describe('mapPermissionDecision', () => {
  it('returns "once" for allow=true, alwaysAllow=false', () => {
    expect(mapPermissionDecision({ allow: true, alwaysAllow: false })).toBe('once');
  });

  it('returns "always" for allow=true, alwaysAllow=true', () => {
    expect(mapPermissionDecision({ allow: true, alwaysAllow: true })).toBe('always');
  });

  it('returns "reject" for allow=false, alwaysAllow=false', () => {
    expect(mapPermissionDecision({ allow: false, alwaysAllow: false })).toBe('reject');
  });

  it('returns "reject" for allow=false, alwaysAllow=true', () => {
    expect(mapPermissionDecision({ allow: false, alwaysAllow: true })).toBe('reject');
  });

  it('returns "reject" for null decision', () => {
    expect(mapPermissionDecision(null)).toBe('reject');
  });

  it('returns "reject" for undefined decision', () => {
    expect(mapPermissionDecision(undefined)).toBe('reject');
  });

  it('coerces truthy allow to "once"', () => {
    expect(mapPermissionDecision({ allow: 1, alwaysAllow: 0 })).toBe('once');
  });
});

describe('extractPermissionRequest', () => {
  it('extracts V2 permission.asked event', () => {
    const event = {
      type: 'permission.asked',
      properties: {
        requestID: 'req-abc',
        permission: 'bash',
        patterns: ['*.sh'],
        metadata: { desc: 'run shell' },
        always: ['/bin/bash'],
        tool: { name: 'bash' },
        sessionID: 'sess-1',
      },
    };
    const result = extractPermissionRequest(event);
    expect(result).toEqual({
      requestId: 'req-abc',
      toolInput: {
        permission: 'bash',
        patterns: ['*.sh'],
        metadata: { desc: 'run shell' },
        always: ['/bin/bash'],
        tool: { name: 'bash' },
      },
    });
  });

  it('falls back to id when requestID is missing', () => {
    const event = {
      type: 'permission.asked',
      properties: { id: 'fallback-id', permission: 'edit' },
    };
    const result = extractPermissionRequest(event);
    expect(result.requestId).toBe('fallback-id');
  });

  it('returns null for missing requestID and id', () => {
    const event = {
      type: 'permission.asked',
      properties: { permission: 'edit' },
    };
    expect(extractPermissionRequest(event)).toBeNull();
  });

  it('returns null for non-permission.asked event type', () => {
    const event = {
      type: 'permission.updated',
      properties: { requestID: 'req-1' },
    };
    expect(extractPermissionRequest(event)).toBeNull();
  });

  it('returns null for session.created event', () => {
    const event = {
      type: 'session.created',
      properties: { info: { id: 'sess-1' } },
    };
    expect(extractPermissionRequest(event)).toBeNull();
  });

  it('defaults arrays and objects when absent', () => {
    const event = {
      type: 'permission.asked',
      properties: { requestID: 'req-2' },
    };
    const result = extractPermissionRequest(event);
    expect(result).toEqual({
      requestId: 'req-2',
      toolInput: {
        permission: null,
        patterns: [],
        metadata: {},
        always: [],
        tool: null,
      },
    });
  });

  it('coerces non-array patterns to empty array', () => {
    const event = {
      type: 'permission.asked',
      properties: { requestID: 'req-3', patterns: 'not-an-array' },
    };
    const result = extractPermissionRequest(event);
    expect(result.toolInput.patterns).toEqual([]);
  });
});

describe('convertOpencodePermissionTool', () => {
  it('maps ambient permission names to request-permissions tool use', () => {
    const msg = convertOpencodePermissionTool('2026-01-01T00:00:00.000Z', 'perm-1', {
      permission: 'bash',
      patterns: ['*.sh'],
      metadata: { desc: 'run shell' },
      always: ['/bin/bash'],
      tool: { name: 'bash' },
    });

    expect(msg).toBeInstanceOf(RequestPermissionsToolUseMessage);
    expect(msg.reason).toBe('Bash');
    expect(msg.permissions.patterns).toEqual(['*.sh']);
    expect(msg.permissions.tool).toEqual({ name: 'bash' });
  });

  it('maps plan_enter to EnterPlanMode', () => {
    const msg = convertOpencodePermissionTool('2026-01-01T00:00:00.000Z', 'perm-2', {
      permission: 'plan_enter',
    });

    expect(msg).toBeInstanceOf(EnterPlanModeToolUseMessage);
  });

  it('uses UnknownToolUseMessage only when permission identity is missing', () => {
    const msg = convertOpencodePermissionTool('2026-01-01T00:00:00.000Z', 'perm-3', {});

    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('Unknown');
  });
});

describe('mapPermissionMode', () => {
  it('maps bypassPermissions to allow all OpenCode permission keys', () => {
    const rules = mapPermissionMode('bypassPermissions');
    expect(rules).toHaveLength(OPENCODE_PERMISSION_KEYS.length);
    expect(rules).toEqual(
      OPENCODE_PERMISSION_KEYS.map((permission) => ({
        permission,
        pattern: '*',
        action: 'allow',
      })),
    );
  });

  it('includes external_directory in bypassPermissions', () => {
    const rules = mapPermissionMode('bypassPermissions');
    expect(rules).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'allow',
    });
  });

  it('emits ask rules for default mode', () => {
    expect(mapPermissionMode('default')).toEqual([
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: '*', action: 'ask' },
    ]);
  });

  it('emits default ask rules for manual bypass mode', () => {
    expect(mapPermissionMode('manualBypass')).toEqual(mapPermissionMode('default'));
  });

  it('falls back to default mode for unknown mode', () => {
    expect(mapPermissionMode('unknown-mode')).toEqual(mapPermissionMode('default'));
  });
});

describe('OpenCodeRuntime permissions', () => {
  let provider;
  let client;
  let promptHarness;

  beforeEach(async () => {
    const { OpenCodeRuntime } = await import('../opencode.js');
    const promptAsync = mock(() => Promise.resolve());
    promptHarness = createPromptHarness(promptAsync);
    client = {
      permission: { reply: mock(() => Promise.resolve({ data: true })) },
      global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
      session: {
        create: mock(() => Promise.resolve({ data: { id: 'sess-1' } })),
        prompt: (...args) => promptHarness.prompt(...args),
        promptAsync,
        abort: mock(() => Promise.resolve()),
      },
      provider: {
        list: mock(() => Promise.resolve({ data: { all: [], connected: [] } })),
      },
    };
    provider = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client,
        server: { close: () => {} },
      })),
    });
    client = await provider.getClient();
    client.session.create.mockClear();
    client.permission.reply.mockClear();
  });

  it('passes comprehensive bypass permission rules at session creation', async () => {
    const published = collectOperation('run-bypass');
    await provider.startSession({
      command: 'test command',
      chatId: '123',
      permissionMode: 'bypassPermissions',
      operation: published.operation,
    });

    expect(client.session.create.mock.calls[0][0]).toEqual({
      permission: OPENCODE_PERMISSION_KEYS.map((permission) => ({
        permission,
        pattern: '*',
        action: 'allow',
      })),
    });
  });

  it('auto-replies once for manual bypass permission events without emitting a permission row', async () => {
    const eventStream = createAsyncEventStream(promptHarness);
    client.global.event.mockImplementation(() => Promise.resolve({ stream: eventStream.stream() }));
    const published = collectOperation('run-manual');

    await provider.startSession({
      command: 'test command',
      chatId: '123',
      permissionMode: 'manualBypass',
      operation: published.operation,
    });

    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_prompt_manual',
        type: 'message.part.updated',
        properties: {
          sessionID: 'sess-1',
          part: {
            id: client.session.promptAsync.mock.calls[0][0].parts[0].id,
            messageID: 'user-manual',
            type: 'text',
            text: 'test command',
          },
        },
      },
    });
    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_assistant_manual',
        type: 'message.updated',
        properties: {
          sessionID: 'sess-1',
          info: { id: 'assistant-manual', role: 'assistant', parentID: 'user-manual' },
        },
      },
    });
    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_permission_manual',
        type: 'permission.asked',
        properties: {
          sessionID: 'sess-1',
          requestID: 'req-manual',
          permission: 'bash',
          tool: { messageID: 'assistant-manual', callID: 'call-manual' },
        },
      },
    });

    await waitForMockCall(client.permission.reply);
    expect(client.permission.reply.mock.calls[0][0]).toEqual({
      requestID: 'req-manual',
      reply: 'once',
    });
    expect(published.events.some((event) => event.type === 'permission')).toBe(false);

    eventStream.close();
    provider.shutdown();
  });

  it('isolates a failed manual bypass reply without stalling the global event stream', async () => {
    const eventStream = createAsyncEventStream(promptHarness);
    const reply = deferred();
    client.global.event.mockImplementation(() => Promise.resolve({ stream: eventStream.stream() }));
    client.session.create
      .mockImplementationOnce(() => Promise.resolve({ data: { id: 'sess-1' } }))
      .mockImplementationOnce(() => Promise.resolve({ data: { id: 'sess-2' } }));
    client.permission.reply.mockImplementation(() => reply.promise);
    const manual = collectOperation('run-manual');
    const healthy = collectOperation('run-healthy');

    await provider.startSession({
      command: 'manual command',
      chatId: 'chat-manual',
      permissionMode: 'manualBypass',
      operation: manual.operation,
    });
    await provider.startSession({
      command: 'healthy command',
      chatId: 'chat-healthy',
      permissionMode: 'default',
      operation: healthy.operation,
    });

    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_manual_prompt',
        type: 'message.part.updated',
        properties: {
          sessionID: 'sess-1',
          part: {
            id: client.session.promptAsync.mock.calls[0][0].parts[0].id,
            messageID: 'user-manual',
            type: 'text',
            text: 'manual command',
          },
        },
      },
    });
    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_manual_assistant',
        type: 'message.updated',
        properties: {
          sessionID: 'sess-1',
          info: { id: 'assistant-manual', role: 'assistant', parentID: 'user-manual' },
        },
      },
    });
    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_0001',
        type: 'permission.asked',
        properties: {
          sessionID: 'sess-1',
          requestID: 'req-manual',
          permission: 'bash',
          tool: { messageID: 'assistant-manual', callID: 'call-manual' },
        },
      },
    });
    await waitForMockCall(client.permission.reply);

    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_0002',
        type: 'message.updated',
        properties: { sessionID: 'sess-2', info: { id: 'user-2', role: 'user' } },
      },
    });
    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_0003',
        type: 'message.part.updated',
        properties: {
          sessionID: 'sess-2',
          part: {
            id: client.session.promptAsync.mock.calls[1][0].parts[0].id,
            messageID: 'user-2',
            type: 'text',
            text: 'healthy command',
          },
        },
      },
    });
    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_0004',
        type: 'message.updated',
        properties: {
          sessionID: 'sess-2',
          info: { id: 'assistant-2', role: 'assistant', parentID: 'user-2' },
        },
      },
    });
    eventStream.push({
      directory: '/repo',
      payload: {
        id: 'evt_0005',
        type: 'message.updated',
        properties: {
          sessionID: 'sess-2',
          info: {
            id: 'assistant-2',
            role: 'assistant',
            parentID: 'user-2',
            finish: 'stop',
            time: { completed: Date.now() },
          },
        },
      },
    });
    await waitFor(() => healthy.events.some((event) => event.type === 'run-ended'));
    expect(healthy.events).toContainEqual({
      type: 'run-ended',
      runId: 'run-healthy',
      outcome: 'finished',
    });
    expect(manual.events.some((event) => event.type === 'run-ended')).toBe(false);

    reply.reject(new Error('permission endpoint failed'));
    await waitFor(() => manual.events.some((event) => event.type === 'run-ended'));
    expect(manual.events).toContainEqual({
      type: 'run-ended',
      runId: 'run-manual',
      outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message: 'permission endpoint failed' },
    });
    expect(client.global.event).toHaveBeenCalledTimes(1);

    eventStream.close();
    await provider.shutdown();
  });
});
