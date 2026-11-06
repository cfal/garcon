import { CONVERSATION_PRESENTATION } from '../automation.js';
import { describe, expect, it } from 'bun:test';
import { parseChatListResponse } from '../chat-list.ts';
import { AUTOMATION_PRESENTATION } from '../automation.js';
import { parsePromoteChatRequest, parsePromoteChatResponse } from '../chat-presentation-contracts.js';

const CHAT_ID = '1785337200123456';
const TS = '2026-09-07T00:00:00.000Z';

function response() {
  return {
    sessions: [{
      presentation: CONVERSATION_PRESENTATION,
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
  it('requires explicit, validated presentation and keeps automation in unfiltered lists', () => {
    const value = response();
    value.sessions[0].presentation = AUTOMATION_PRESENTATION;
    expect(parseChatListResponse(value).sessions[0].presentation).toEqual(AUTOMATION_PRESENTATION);
    for (const presentation of [undefined, null, {}, { collection: 'hidden', notifications: 'normal' }]) {
      value.sessions[0].presentation = presentation;
      expect(() => parseChatListResponse(value)).toThrow('presentation');
    }
  });
  it('parses promotion without accepting policy or authority fields', () => {
    expect(parsePromoteChatRequest({ chatId: CHAT_ID })).toEqual({ chatId: CHAT_ID });
    expect(parsePromoteChatRequest({ chatId: CHAT_ID, automationPolicy: { inBandCommands: 'inherit' } })).toBeNull();
    expect(parsePromoteChatRequest({ chatId: 'invalid' })).toBeNull();
    const promoted = { success: true, chat: response().sessions[0] };
    expect(parsePromoteChatResponse(promoted)).toEqual(promoted);
    expect(parsePromoteChatResponse({ ...promoted, chat: { ...promoted.chat, presentation: AUTOMATION_PRESENTATION } })).toBeNull();
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
