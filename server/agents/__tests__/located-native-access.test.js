import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createLocatedInstanceFixture, LOCATED_CHATS } from './located-instance-fixture.js';

describe('instance-qualified native access', () => {
  let fixture;
  beforeEach(async () => { fixture = await createLocatedInstanceFixture(); });
  afterEach(async () => { await fixture?.dispose(); });

  it('adopts colliding native session IDs from separate instance-owned legacy sources', async () => {
    for (const [profile, chatId] of Object.entries(LOCATED_CHATS)) {
      await fixture.adoption.ensure(chatId);
      expect(fixture.ledger.conversationMessages(chatId).map((row) => row.content)).toEqual([`${profile} legacy`]);
      expect(fixture[profile].integration.legacyHistoryImport.load).toHaveBeenCalledOnce();
      expect(fixture[profile].integration.nativeHistoryImport.load).not.toHaveBeenCalled();
      expect(fixture.chats.lookupNativeSession('colliding-session', 'test', {
        nodeId: 'local-node', instanceId: profile,
      })).toMatchObject({ status: 'found', chatId });
    }
    expect(fixture.chats.lookupNativeSession('colliding-session', 'test')).toMatchObject({ status: 'ambiguous' });
  });

  it('resolves native sessions and source descriptions only on their exact instances', async () => {
    const chatId = LOCATED_CHATS.secondary;
    const owner = fixture.chats.getChat(chatId);
    expect(await fixture.agents.resolveNativeSession(owner, chatId)).toMatchObject({ value: { profile: 'secondary' } });
    expect(await fixture.agents.describeTranscriptSource(owner, chatId)).toEqual({
      kind: 'provider-reference', value: 'secondary/colliding-session',
    });
    expect(fixture.primary.integration.nativeSessions.resolveNativeSession).not.toHaveBeenCalled();
    expect(fixture.primary.integration.nativeSessions.describeSource).not.toHaveBeenCalled();
  });

  it('reloads only the selected instance and leaves its same-provider peer view untouched', async () => {
    const primaryView = await fixture.adoption.ensure(LOCATED_CHATS.primary);
    const secondaryView = await fixture.adoption.ensure(LOCATED_CHATS.secondary);
    const replacement = await fixture.reload.reload(LOCATED_CHATS.secondary);
    expect(replacement.viewId).not.toBe(secondaryView.viewId);
    expect(fixture.ledger.currentView(LOCATED_CHATS.primary)).toEqual(primaryView);
    expect(fixture.ledger.conversationMessages(LOCATED_CHATS.secondary).map((row) => row.content)).toEqual(['secondary native']);
    expect(fixture.primary.integration.nativeHistoryImport.load).not.toHaveBeenCalled();
    expect(fixture.secondary.integration.nativeHistoryImport.load).toHaveBeenCalledOnce();
  });

  it('reads a native-fidelity fork through its captured source instance after the registry owner changes', async () => {
    const chatId = LOCATED_CHATS.secondary;
    const sourceSession = fixture.chats.getChat(chatId);
    fixture.chats.updateChat(chatId, {
      projectPath: fixture.root, executionLocation: fixture.chats.getChat(LOCATED_CHATS.primary).executionLocation,
    });
    const rows = await fixture.readFork({
      targetChatId: '1000000000000003', sourceSession,
      fork: { agentSessionId: 'colliding-fork', nativeSession: sourceSession.nativeSession, nativeSeedReceipt: null },
      signal: new AbortController().signal, preambleEvidence: [],
    });
    expect(rows.map((row) => row.message.content)).toEqual(['secondary native']);
    expect(fixture.secondary.integration.nativeHistoryImport.load).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ agentSessionId: 'colliding-fork', settings: expect.objectContaining({
        values: { parsedBy: 'secondary' },
      }) }),
    }));
    expect(fixture.primary.integration.nativeHistoryImport.load).not.toHaveBeenCalled();
  });

  it('serves an existing ledger and repairs its cache with the owner unavailable, while native work fails closed', async () => {
    const chatId = LOCATED_CHATS.secondary;
    const view = await fixture.adoption.ensure(chatId);
    fixture.chats.updateChat(chatId, {
      projectPath: fixture.root,
      executionLocation: { nodeId: 'offline-node', instanceId: 'secondary', workspaceId: 'project' },
      agentSessionId: 'stale-cache', nativeSession: null,
    });
    expect(await fixture.adoption.ensure(chatId)).toEqual(view);
    expect(fixture.chats.getChat(chatId).agentSessionId).toBe('colliding-session');
    expect(await fixture.agents.getPreview(fixture.chats.getChat(chatId), chatId)).toMatchObject({
      preview: { lastMessage: 'secondary legacy' },
    });
    expect(await fixture.agents.describeTranscriptSource(fixture.chats.getChat(chatId), chatId)).toBeNull();
    await expect(fixture.reload.reload(chatId)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    await expect(fixture.agents.resolveNativeSession(fixture.chats.getChat(chatId), chatId))
      .rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(fixture.ledger.currentView(chatId)).toEqual(view);
    expect(fixture.primary.integration.legacyHistoryImport.load).not.toHaveBeenCalled();
    expect(fixture.primary.integration.nativeHistoryImport.load).not.toHaveBeenCalled();
    expect(fixture.primary.integration.nativeSessions.resolveNativeSession).not.toHaveBeenCalled();
  });

  it('does not turn unavailable-instance genesis into a permanent empty view', async () => {
    const chatId = LOCATED_CHATS.secondary;
    fixture.chats.updateChat(chatId, {
      projectPath: fixture.root,
      executionLocation: { nodeId: 'offline-node', instanceId: 'secondary', workspaceId: 'project' },
    });
    await expect(fixture.adoption.ensure(chatId)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(fixture.ledger.currentView(chatId)).toBeNull();
    expect(fixture.primary.integration.legacyHistoryImport.load).not.toHaveBeenCalled();
  });
});
