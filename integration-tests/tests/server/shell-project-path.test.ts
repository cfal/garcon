import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('Shell folder changes retain native identity and apply to the next command', async () => {
  await withIntegrationFixture('shell-project-path', async fixture => {
    const { client, executionDirs } = fixture;
    const chatId = fixture.newChatId();
    const started = await client.startChat({
      chatId, agentId: 'shell', model: 'sh', projectPath: executionDirs.project,
      permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
      origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'true',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await client.waitForProcessing(chatId, false);
    const before = await client.get<ChatDetailsResponse>(`/api/v1/chats/details?chatId=${chatId}`);
    expect(before.agentSessionId).toBeTruthy();
    const destination = join(executionDirs.project, 'next');
    await mkdir(destination);
    for (const projectPath of [destination, executionDirs.project, destination]) {
      expect(await client.updateProjectPath({ chatId, projectPath })).toMatchObject({ projectPath });
      const snapshot = await client.getChatSnapshot(chatId);
      const details = await client.get<ChatDetailsResponse>(`/api/v1/chats/details?chatId=${chatId}`);
      expect(details.agentSessionId).toBe(before.agentSessionId);
      expect(snapshot.chat.projectPath).toBe(projectPath);
    }
    const run = await client.runChat({ chatId, clientRequestId: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(), command: 'pwd -P' });
    await client.waitForTurnTerminal(chatId, run.turnId);
    await client.waitForProcessing(chatId, false);
    await client.reloadChat(chatId);
    const messages = (await client.getMessages(chatId)).messages.map(row => row.message);
    expect(messages.filter(message => message.type === 'user-message')).toHaveLength(2);
    expect(messages.find(message => message.type === 'command-output' && message.channel === 'stdout')).toMatchObject({
      channel: 'stdout', content: `${destination}\n`, context: { executorId: client.executorId, projectPath: destination },
    });
  }, { projectRoots: 'separate' });
}, 60_000);
