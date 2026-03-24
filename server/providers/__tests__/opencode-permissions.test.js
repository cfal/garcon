// Permission flow tests for OpenCodeProvider (V2-only).
// Tests permission extraction, decision mapping, guard paths, and the full
// permission lifecycle through the SSE event stream.

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  mapPermissionDecision,
  extractPermissionRequest,
  mapPermissionMode,
  OPENCODE_PERMISSION_KEYS,
} from '../opencode.js';
import { convertOpencodePermissionTool } from '../converters/opencode-permission-tool.js';
import { EnterPlanModeToolUseMessage, UnknownToolUseMessage } from '../../../common/chat-types.js';

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
      providerPermission: {
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
      providerPermission: {
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
    expect(result.providerPermission.patterns).toEqual([]);
  });
});

describe('convertOpencodePermissionTool', () => {
  it('canonicalizes bash permission names before emitting to the client', () => {
    const msg = convertOpencodePermissionTool('2026-01-01T00:00:00.000Z', 'perm-1', {
      permission: 'bash',
      patterns: ['*.sh'],
      metadata: { desc: 'run shell' },
      always: ['/bin/bash'],
      tool: { name: 'bash' },
    });

    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('Bash');
    expect(msg.input.patterns).toEqual(['*.sh']);
  });

  it('maps plan_enter to EnterPlanMode', () => {
    const msg = convertOpencodePermissionTool('2026-01-01T00:00:00.000Z', 'perm-2', {
      permission: 'plan_enter',
    });

    expect(msg).toBeInstanceOf(EnterPlanModeToolUseMessage);
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

  it('falls back to default mode for unknown mode', () => {
    expect(mapPermissionMode('unknown-mode')).toEqual(mapPermissionMode('default'));
  });
});

describe('OpenCodeProvider resolvePermission guards', () => {
  let provider;
  let client;

  beforeEach(async () => {
    // Stub SDK at module level before importing provider.
    // Since bun:test mock.module is hoisted, we re-import to get fresh state.
    mock.module('@opencode-ai/sdk/v2', () => ({
      createOpencode: mock(() =>
        Promise.resolve({
          client: {
            permission: { reply: mock(() => Promise.resolve({ data: true })) },
            event: { subscribe: mock(() => Promise.resolve({ stream: [] })) },
            session: {
              create: mock(() => Promise.resolve({ data: { id: 'sess-1' } })),
              promptAsync: mock(() => Promise.resolve()),
              abort: mock(() => Promise.resolve()),
            },
            provider: {
              list: mock(() => Promise.resolve({ data: { all: [], connected: [] } })),
            },
          },
          server: { url: 'http://localhost:0', close: () => {} },
        }),
      ),
    }));

    // Dynamic import to pick up the mock.
    const { OpenCodeProvider } = await import('../opencode.js');
    provider = new OpenCodeProvider();
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

    expect(client.session.create).toHaveBeenCalledWith({
      permission: OPENCODE_PERMISSION_KEYS.map((permission) => ({
        permission,
        pattern: '*',
        action: 'allow',
      })),
    });
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
