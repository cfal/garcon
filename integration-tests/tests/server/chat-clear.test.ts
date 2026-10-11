import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClearChatRequest, ClearChatResponse } from '../../../common/chat-clear.js';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('ledger clear preserves Shell cwd/session and native Reload restores history', async () => {
  await withIntegrationFixture('chat-clear-shell', async fixture => {
    const { client, executionDirs } = fixture;
    const chatId = fixture.newChatId();
    const first = await client.startChat({ chatId, agentId: 'shell', model: 'sh', projectPath: executionDirs.project,
      permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
      origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
      command: 'mkdir next; cd next; printf synthetic-cleared-output',
    });
    await client.waitForTurnTerminal(chatId, first.turnId);
    await client.waitForProcessing(chatId, false);
    const original = await client.getMessages(chatId);
    const before = (await client.listChats()).sessions.find(chat => chat.id === chatId)!;
    const detailsPath = `/api/v1/chats/details?${new URLSearchParams({ chatId })}`;
    const beforeDetails = await client.get<ChatDetailsResponse>(detailsPath);
    expect(beforeDetails.agentSessionId).toBeTruthy();
    const request: ClearChatRequest = { chatId, transcriptViewId: original.transcriptViewId, lastOrdinal: original.lastOrdinal };
    const cleared = await client.post<ClearChatResponse>('/api/v1/chats/clear', request);
    expect(cleared.transcriptViewId).not.toBe(original.transcriptViewId);
    expect((await client.getMessages(chatId)).messages).toEqual([]);
    await fixture.restartGarcon();
    expect((await fixture.client.getMessages(chatId)).messages).toEqual([]);
    const resumed = await fixture.client.runChat({ chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'pwd' });
    await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
    await fixture.client.waitForProcessing(chatId, false);
    const continued = (await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)!;
    expect(continued.preview.firstMessage).toBe('pwd');
    expect(continued.title).toBe('pwd');
    const current = await fixture.client.getMessages(chatId);
    expect(current.messages.some(row => row.message.type === 'command-output' && row.message.content.trim() === before.projectPath)).toBe(true);
    expect(current.messages.some(row => row.message.type === 'command-output' && row.message.content.includes('synthetic-cleared-output'))).toBe(false);
    expect(await rejectionOf(fixture.client.post('/api/v1/chats/clear', request))).toMatchObject({ status: 409, body: { errorCode: 'STALE_TRANSCRIPT_VIEW' } });
    await fixture.client.reloadChat(chatId);
    const restored = await fixture.client.getMessages(chatId);
    expect(restored.messages.some(row => row.message.type === 'command-output' && row.message.content.includes('synthetic-cleared-output'))).toBe(true);
    const after = (await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)!;
    expect(after.projectPath).toBe(before.projectPath);
    const afterDetails = await fixture.client.get<ChatDetailsResponse>(detailsPath);
    expect(afterDetails.agentSessionId).toBe(beforeDetails.agentSessionId);
  });
}, 60_000);

test('Clear removes inherited fork history and Reload restores only the bound native session', async () => {
  await withIntegrationFixture('chat-clear-fork', async fixture => {
    const { client } = fixture;
    const sourceChatId = fixture.newChatId();
    const started = await client.startChat({ chatId: sourceChatId, agentId: 'shell', model: 'sh',
      projectPath: fixture.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
      agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
      clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'printf synthetic-inherited-output' });
    await client.waitForTurnTerminal(sourceChatId, started.turnId);
    await client.waitForProcessing(sourceChatId, false);
    for (const hasNativeSession of [false, true]) {
      const chatId = fixture.newChatId();
      await client.forkChat({ sourceChatId, chatId, allowHandoffFork: true });
      const run = async (command: string) => {
        const turn = await client.runChat({ chatId, command, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
        await client.waitForTurnTerminal(chatId, turn.turnId);
        await client.waitForProcessing(chatId, false);
      };
      if (hasNativeSession) await run('printf synthetic-native-output');
      const before = await client.getMessages(chatId);
      expect(before.messages.some(row => row.message.type === 'command-output' && row.message.content === 'synthetic-inherited-output')).toBe(true);
      await client.post('/api/v1/chats/clear', { chatId, transcriptViewId: before.transcriptViewId, lastOrdinal: before.lastOrdinal });
      expect((await client.getMessages(chatId)).messages).toEqual([]);
      await run('printf synthetic-new-output');
      await client.reloadChat(chatId);
      const outputs = (await client.getMessages(chatId)).messages.flatMap(row =>
        row.message.type === 'command-output' && row.message.channel === 'stdout' ? [row.message.content] : []);
      expect(outputs).toEqual(hasNativeSession ? ['synthetic-native-output', 'synthetic-new-output'] : ['synthetic-new-output']);
    }
    expect((await client.getMessages(sourceChatId)).messages.some(row => row.message.type === 'command-output' && row.message.content === 'synthetic-inherited-output')).toBe(true);
  });
}, 60_000);

test('ledger clear removes Shell history from search', async () => {
  await withIntegrationFixture('chat-clear-search', async fixture => {
    const { client } = fixture;
    await client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
    const chatId = fixture.newChatId();
    const first = await client.startChat({ chatId, agentId: 'shell', model: 'sh', projectPath: fixture.executionDirs.project,
      permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
      origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
      command: 'printf syntheticclearneedle' });
    await client.waitForTurnTerminal(chatId, first.turnId);
    await client.waitForProcessing(chatId, false);
    const query = { query: 'syntheticclearneedle' };
    await client.waitForChatSearch(query, result => result.results.some(match => match.chatId === chatId));
    const original = await client.getMessages(chatId);
    await client.post('/api/v1/chats/clear', { chatId, transcriptViewId: original.transcriptViewId, lastOrdinal: original.lastOrdinal } satisfies ClearChatRequest);
    expect((await client.getMessages(chatId)).messages).toEqual([]);
    await client.waitForChatSearch(query, result => result.results.every(match => match.chatId !== chatId));
    await client.reloadChat(chatId);
    expect((await client.getMessages(chatId)).messages.some(row => row.message.type === 'command-output' && row.message.content === 'syntheticclearneedle')).toBe(true);
  });
}, 60_000);

test('rejects Clear for conversational agents without changing history or native context', async () => {
  await withIntegrationFixture('chat-clear-unsupported', async fixture => {
    const { client, directAgents } = fixture;
    const chatId = fixture.newChatId();
    const first = await client.startDirectChat({ chatId, agent: directAgents.openAi, projectPath: fixture.executionDirs.project,
      content: 'synthetic-retained-history' });
    await client.waitForTurnTerminal(chatId, first.turnId);
    await client.waitForProcessing(chatId, false);
    const original = await client.getMessages(chatId);
    expect(await rejectionOf(client.post('/api/v1/chats/clear', {
      chatId, transcriptViewId: original.transcriptViewId, lastOrdinal: original.lastOrdinal,
    } satisfies ClearChatRequest))).toMatchObject({ status: 422, body: { errorCode: 'OPERATION_UNSUPPORTED', retryable: false } });
    expect(await client.getMessages(chatId)).toEqual(original);
    const next = await client.runDirectChat({ chatId, agent: directAgents.openAi, content: 'synthetic-followup' });
    await client.waitForTurnTerminal(chatId, next.turnId);
    expect(fixture.fakeProviders.openAi.requests().at(-1)?.body.messages.map(message => message.content))
      .toEqual(['synthetic-retained-history', 'echo:synthetic-retained-history', 'synthetic-followup']);
  });
}, 60_000);

test('cold Clear previews never substitute a later input when bounded reconstruction is unavailable', async () => {
  await withIntegrationFixture('chat-clear-cold-preview', async fixture => {
    const chatId = fixture.newChatId();
    const started = await fixture.client.startChat({ chatId, agentId: 'shell', model: 'sh',
      projectPath: fixture.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
      agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
      clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'printf synthetic-old' });
    await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    await fixture.client.waitForProcessing(chatId, false);
    const original = await fixture.client.getMessages(chatId);
    await fixture.client.post('/api/v1/chats/clear', {
      chatId, transcriptViewId: original.transcriptViewId, lastOrdinal: original.lastOrdinal,
    } satisfies ClearChatRequest);
    const run = async (command: string) => {
      const turn = await fixture.client.runChat({ chatId, command,
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
      await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
      await fixture.client.waitForProcessing(chatId, false);
    };
    await run(`printf synthetic-first\n#${'x'.repeat(80 * 1024)}`);
    const metadataPath = join(fixture.dirs.workspace, 'chat-metadata.json');
    await fixture.restartGarcon({ beforeStart: async () => {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      // Reproduces a durable first input whose preview missed the post-Clear save.
      metadata.chats[chatId].firstMessage = '';
      metadata.chats[chatId].lastMessage = '';
      await writeFile(metadataPath, JSON.stringify(metadata));
    } });
    await run('printf synthetic-later');
    expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.title).toBe('New Session');
    await fixture.restartGarcon();
    const persisted = JSON.parse(await readFile(metadataPath, 'utf8'));
    expect(persisted.chats[chatId].firstMessage).toBe('');
    expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.title).toBe('New Session');
    const messages = (await fixture.client.getMessages(chatId)).messages;
    expect(messages.some(row => row.message.type === 'command-output' && row.message.content === 'synthetic-first')).toBe(true);
    expect(messages.some(row => row.message.type === 'command-output' && row.message.content === 'synthetic-later')).toBe(true);
  });
}, 60_000);
