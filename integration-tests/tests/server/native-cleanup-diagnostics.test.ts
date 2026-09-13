import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseNativeCleanupSnapshot, parseNativeCleanupRetryResult } from '../../../common/native-cleanup.js';
import type { AgentOwnershipJournalFile, DeleteIntent } from '../../../server/chats/agent-ownership-journal.js';
import { ChatRegistry } from '../../../server/chats/store.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

test('authenticated cleanup diagnostics retain a contradictory restored epoch across real controller restarts', async () => {
  await withIntegrationFixture('native-cleanup-diagnostics', async (fixture) => {
    const chatId = fixture.newChatId();
    const agent = fixture.directAgents.openAi;
    const started = await fixture.client.startDirectChat({ chatId, agent, projectPath: fixture.dirs.project,
      content: 'synthetic native cleanup input' });
    await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    const history = await fixture.client.getMessages(chatId);
    const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: agent.agentId });
    const nativePath = join(fixture.dirs.workspace, 'agent-data', agent.agentId, 'direct-sessions-v1', `${native.agentSessionId}.jsonl`);
    expect(existsSync(nativePath)).toBe(true);
    let intent: DeleteIntent | null = null;
    const operationId = 'synthetic-restored-delete';
    const journalPath = join(fixture.dirs.workspace, 'agent-ownership-journal.json');
    await fixture.restartGarcon({ beforeStart: async () => {
      const registry = new ChatRegistry(fixture.dirs.workspace); await registry.init();
      const chat = registry.getChat(chatId)!;
      intent = { version: 3, kind: 'delete', operationId, chatId, phase: 'prepared', sourceEpoch: chat.agentOwnershipEpoch,
        createdAt: '2026-09-13T00:00:00.000Z', releaseReferences: [{ executionLocation: chat.executionLocation,
          chat: { chatId, agentId: chat.agentId, agentSessionId: chat.agentSessionId, projectPath: chat.projectPath, model: chat.model,
            nativeSession: chat.nativeSession, nativeSeedReceipt: chat.nativeSeedReceipt, carryOverRevision: '',
            settings: chat.agentSettingsById[chat.agentId] ?? null } }] };
      await writeFile(journalPath, JSON.stringify({ version: 6, ownershipIntents: [intent] } satisfies AgentOwnershipJournalFile));
      await registry.updateChat(chatId, { agentOwnershipEpoch: 'synthetic-conflicting-restored-epoch' }, { flush: true });
    } });
    const anonymous = await fetch(`${fixture.client.baseUrl}/api/v1/native-cleanup`);
    expect(anonymous.status).toBe(401);
    const snapshot = parseNativeCleanupSnapshot(await fixture.client.get('/api/v1/native-cleanup'));
    expect(snapshot?.entries).toHaveLength(1);
    expect(snapshot?.entries[0]).toMatchObject({ chatId, operationId, status: 'ownership-conflict',
      registryEpoch: 'synthetic-conflicting-restored-epoch' });
    const diagnostic = JSON.stringify(snapshot);
    expect(diagnostic).not.toContain(fixture.dirs.project);
    expect(diagnostic).not.toContain(native.agentSessionId!);
    const before = await readFile(journalPath, 'utf8');
    await expect(fixture.client.post('/api/v1/native-cleanup/retry', { chatId, operationId }))
      .rejects.toMatchObject({ status: 409, body: { errorCode: 'STALE_CHAT_OWNERSHIP' } });
    expect(await readFile(journalPath, 'utf8')).toBe(before);
    expect(existsSync(nativePath)).toBe(true);
    expect(await fixture.client.getMessages(chatId)).toEqual(history);
    await fixture.restartGarcon({ beforeStart: async () => {
      const registry = new ChatRegistry(fixture.dirs.workspace); await registry.init();
      if (!intent?.sourceEpoch) throw new Error('Synthetic original deletion missing');
      await registry.updateChat(chatId, { agentOwnershipEpoch: intent.sourceEpoch }, { flush: true });
    } });
    expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBe(false);
    expect(parseNativeCleanupRetryResult(await fixture.client.post('/api/v1/native-cleanup/retry', { chatId, operationId })))
      .toEqual({ kind: 'not-found' });
    expect(parseNativeCleanupSnapshot(await fixture.client.get('/api/v1/native-cleanup'))).toEqual({ entries: [] });
    expect(existsSync(nativePath)).toBe(false);
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
  }, { authentication: 'account', bindAddress: '0.0.0.0' });
}, 30_000);
