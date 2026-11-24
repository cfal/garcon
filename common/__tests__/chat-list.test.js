import { describe, expect, it } from 'bun:test';
import { parseChatListResponse } from '../chat-list.ts';

const CHAT_ID = '1785337200123456';
const TS = '2026-09-07T00:00:00.000Z';

function response() {
  return {
    sessions: [{
      id: CHAT_ID,
      parentChatId: null,
      lineage: null,
      agentId: 'codex',
      agentOwnershipEpoch: 'epoch-1',
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
      title: 'Search work',
      projectPath: '/garcon/.worktrees/deleted',
      orderGroup: 'normal',
      tags: ['cli'],
      activity: { createdAt: TS, lastActivityAt: TS, lastReadAt: null },
      preview: { firstMessage: 'Find it', lastMessage: 'Done' },
      isPinned: false,
      isArchived: false,
      isActive: false,
      isProcessing: false,
      processingPhase: null,
      activityStatus: null,
      observation: null, canReloadFromNativeHistory: true,
      isUnread: true,
    }],
    total: 1,
    lastSelectedChatId: CHAT_ID,
  };
}

describe('chat list contract', () => {
  it('validates nullable activity status independently of unread state', () => {
    for (const activityStatus of [null, 'working', 'complete', 'error', 'pending-user-action']) {
      const value = response();
      value.sessions[0].activityStatus = activityStatus;
      expect(parseChatListResponse(value).sessions[0].activityStatus).toBe(activityStatus);
    }
    for (const activityStatus of [undefined, 'idle', true]) {
      const value = response();
      value.sessions[0].activityStatus = activityStatus;
      expect(() => parseChatListResponse(value)).toThrow('activityStatus');
    }
  });
  it('preserves optional executor identity and rejects malformed explicit IDs', () => {
    for (const executorId of [undefined, null, 'local', '22222222-2222-4222-8222-222222222222']) {
      const value = response();
      if (executorId !== undefined) value.sessions[0].executorId = executorId;
      expect(parseChatListResponse(value)).toEqual(value);
    }
    for (const executorId of ['', 'unconfigured-name', 12]) {
      const value = response();
      value.sessions[0].executorId = executorId;
      expect(() => parseChatListResponse(value)).toThrow('executorId');
    }
  });
  it('parses every field needed for filtering, joining, and resume admission', () => {
    expect(parseChatListResponse(response())).toEqual(response());
  });

  it('keeps delegation independent from fork and handoff lineage', () => {
    for (const kind of ['fork', 'handoff']) {
      const value = response();
      value.sessions[0].parentChatId = '1785337200123457';
      value.sessions[0].lineage = {
        sourceChatId: '1785337200123458', kind, transcriptViewId: 'source-view', ordinal: 42,
      };
      expect(parseChatListResponse(value)).toEqual(value);
    }
  });

  it('rejects missing, malformed, self-referencing and legacy relationships', () => {
    const lineage = {
      sourceChatId: '1785337200123458', kind: 'fork', transcriptViewId: 'source-view', ordinal: 0,
    };
    for (const patch of [
      { parentChatId: undefined }, { lineage: undefined }, { parentChatId: 'invalid' },
      { parentChatId: CHAT_ID }, { lineage: { ...lineage, sourceChatId: CHAT_ID } },
      { lineage: { ...lineage, ordinal: -1 } }, { lineage: { ...lineage, kind: 'delegation' } },
      { parentChat: null }, { parentChat: { chatId: lineage.sourceChatId, relation: 'delegation' } },
    ]) {
      const value = response();
      Object.assign(value.sessions[0], patch);
      expect(() => parseChatListResponse(value)).toThrow();
    }
    for (const field of ['parentChatId', 'lineage']) {
      const value = response();
      delete value.sessions[0][field];
      expect(() => parseChatListResponse(value)).toThrow(field);
    }
  });

  it('preserves persisted timestamp strings for tolerant downstream ordering', () => {
    const value = response();
    value.sessions[0].activity.createdAt = 'legacy timestamp';
    value.sessions[0].activity.lastActivityAt = 'invalid';
    value.sessions[0].activity.lastReadAt = 'also invalid';

    expect(parseChatListResponse(value).sessions[0].activity).toEqual({
      createdAt: 'legacy timestamp',
      lastActivityAt: 'invalid',
      lastReadAt: 'also invalid',
    });
  });

  it('rejects inconsistent totals, processing, membership, and selection', () => {
    expect(() => parseChatListResponse({ ...response(), total: 2 }))
      .toThrow('total does not match sessions');
    expect(() => parseChatListResponse({
      ...response(),
      sessions: [{ ...response().sessions[0], isProcessing: true }],
    })).toThrow('processing state');
    expect(() => parseChatListResponse({
      ...response(),
      sessions: [{ ...response().sessions[0], orderGroup: 'pinned', isPinned: false }],
    })).toThrow('isPinned');
    expect(() => parseChatListResponse({ ...response(), lastSelectedChatId: 'bad' }))
      .toThrow('lastSelectedChatId');
  });
});
