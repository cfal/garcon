// Permission flow tests for OpenCodeRuntime (V2-only).
// Tests permission extraction, decision mapping, guard paths, and the full
// permission lifecycle through the SSE event stream.

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  mapPermissionDecision,
  extractPermissionRequest,
  mapPermissionMode,
  OPENCODE_PERMISSION_KEYS,
} from '../opencode.js';
import { convertOpencodePermissionTool } from '../permission-tool-converter.js';
import { EnterPlanModeToolUseMessage, PermissionRequestMessage, RequestPermissionsToolUseMessage, UnknownToolUseMessage } from '../../../../common/chat-types.js';

function createAsyncEventStream() {
  const events = [];
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

async function* neverEndingStream() {
  await new Promise(() => {});
}

async function waitForMockCall(fn) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fn.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for mock call');
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
      toolName: 'bash',
      toolInput: {
        permission: 'bash',
        patterns: ['*.sh'],
        metadata: { desc: 'run shell' },
        always: ['/bin/bash'],
        tool: { name: 'bash' },
      },
      sessionID: 'sess-1',
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
      toolName: 'Unknown',
      toolInput: {
        permission: null,
        patterns: [],
        metadata: {},
        always: [],
        tool: null,
      },
      sessionID: null,
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

describe('OpenCodeRuntime resolvePermission guards', () => {
  let provider;
  let client;

  beforeEach(async () => {
    const { OpenCodeRuntime } = await import('../opencode.js');
    client = {
      permission: { reply: mock(() => Promise.resolve({ data: true })) },
      event: { subscribe: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
      session: {
        create: mock(() => Promise.resolve({ data: { id: 'sess-1' } })),
        promptAsync: mock(() => Promise.resolve()),
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
    await provider.startSession({
      command: 'test command',
      chatId: '123',
      permissionMode: 'bypassPermissions',
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
    const eventStream = createAsyncEventStream();
    client.event.subscribe.mockImplementation(() => Promise.resolve({ stream: eventStream.stream() }));
    const emitted = [];
    provider.onMessages((_chatId, messages) => emitted.push(...messages));

    await provider.startSession({
      command: 'test command',
      chatId: '123',
      permissionMode: 'manualBypass',
    });

    eventStream.push({
      id: 'evt_permission_manual',
      type: 'permission.asked',
      properties: {
        sessionID: 'sess-1',
        requestID: 'req-manual',
        permission: 'bash',
      },
    });

    await waitForMockCall(client.permission.reply);
    expect(client.permission.reply.mock.calls[0][0]).toEqual({
      requestID: 'req-manual',
      reply: 'once',
    });
    expect(emitted.some((message) => message instanceof PermissionRequestMessage)).toBe(false);

    eventStream.close();
    provider.shutdown();
  });

  it('returns early for null permissionRequestId', async () => {
    await provider.resolvePermission(null, { allow: true, alwaysAllow: false });
    expect(client.permission.reply).not.toHaveBeenCalled();
  });

  it('returns early for unknown permissionRequestId', async () => {
    await provider.resolvePermission('nonexistent-id', { allow: true, alwaysAllow: false });
    expect(client.permission.reply).not.toHaveBeenCalled();
  });

  it('returns early for empty string permissionRequestId', async () => {
    await provider.resolvePermission('', { allow: true, alwaysAllow: false });
    expect(client.permission.reply).not.toHaveBeenCalled();
  });
});
