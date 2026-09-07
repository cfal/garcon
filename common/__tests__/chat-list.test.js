import { describe, expect, it } from 'bun:test';
import { parseChatListResponse } from '../chat-list.ts';

const CHAT_ID = '1785337200123456';
const TS = '2026-09-07T00:00:00.000Z';

function response() {
  return {
    sessions: [{
      id: CHAT_ID,
      parentChat: null,
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
      canReloadFromNativeHistory: true,
      isUnread: true,
    }],
    total: 1,
    lastSelectedChatId: CHAT_ID,
  };
}

describe('chat list contract', () => {
  it('parses every field needed for filtering, joining, and resume admission', () => {
    expect(parseChatListResponse(response())).toEqual(response());
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
