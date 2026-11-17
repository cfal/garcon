import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SetChatParentResponse } from '../../../common/chat-parent-contracts.js';
import type { ForkRunCommandResponse } from '../../../common/chat-command-contracts.js';
import type { ChatListRefreshRequestedMessage } from '../../../common/ws-events.js';
import { runCli, withCliFixture } from '../../support/cli-fixture.js';

test('parent edits persist, broadcast, and converge through real CLI processes without changing transcripts or order', async () => {
  await withCliFixture('chat-parent', async (fixture) => {
    const ids = [fixture.newChatId(), fixture.newChatId(), fixture.newChatId()] as const;
    for (const chatId of ids) {
      const started = await fixture.client.startDirectChat({ chatId, content: 'Synthetic parent editing task.',
        projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    }
    const [child, parent, replacement] = ids;
    const before = await fixture.client.getChatSnapshot(child);
    const settingsBefore = await fixture.client.get('/api/v1/app/settings');
    const cursor = fixture.client.markEvents();
    const attached = await fixture.client.put<SetChatParentResponse>('/api/v1/chats/parent', { chatId: child, parentChatId: parent });
    expect(attached).toEqual({ success: true, chatId: child, parentChatId: parent, changed: true });
    await fixture.client.waitForEvent((event): event is ChatListRefreshRequestedMessage => event.type === 'chat-list-refresh-requested'
      && event.reason === 'parent-updated' && event.chatId === child, 'parent roster invalidation', { afterIndex: cursor });
    expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === child)?.parentChatId).toEqual(attached.parentChatId);
    const repeated = await runCli(fixture, ['set-parent', child, parent, '--json']);
    expect(repeated, repeated.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(repeated.stdout)).toMatchObject({ changed: false });
    const changed = await runCli(fixture, ['set-parent', child, replacement, '--json']);
    expect(changed, changed.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(changed.stdout)).toMatchObject({ parentChatId: replacement, changed: true });
    const cycle = await runCli(fixture, ['set-parent', replacement, child]);
    expect(cycle.exitCode).not.toBe(0);
    expect(cycle.stderr).toContain('CHAT_PARENT_CYCLE');
    expect(await fixture.client.getChatSnapshot(child)).toMatchObject({
      chat: before.chat, transcript: before.transcript, control: before.control, processingPhase: before.processingPhase,
    });
    expect(await fixture.client.get('/api/v1/app/settings')).toEqual(settingsBefore);
    const stored = JSON.parse(await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'));
    expect(stored.sessions[child].parentChatId).toEqual(replacement);
    await fixture.restartGarcon();
    expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === child)?.parentChatId).toEqual(replacement);
    const cleared = await runCli(fixture, ['set-parent', child, '--clear', '--json']);
    expect(cleared, cleared.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(cleared.stdout)).toMatchObject({ parentChatId: null, changed: true });
    if (fixture.client.executorId !== 'local') {
      await fixture.client.patch(`/api/v1/executors/${fixture.client.executorId}`, { allowControllerCli: false });
      const denied = await runCli(fixture, ['set-parent', child, parent]);
      expect(denied.exitCode).not.toBe(0);
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === child)?.parentChatId).toBeNull();
    }
  });
});

test.each(['fork', 'handoff'] as const)('%s keeps lineage through parent assignment, replacement, clearing and restart', async (kind) => {
  await withCliFixture(`chat-parent-${kind}`, async (fixture) => {
    const [source, parent, replacement] = [fixture.newChatId(), fixture.newChatId(), fixture.newChatId()] as const;
    for (const chatId of [source, parent, replacement]) {
      const started = await fixture.client.startDirectChat({ chatId, content: 'Synthetic source task.',
        projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    }
    await fixture.client.put('/api/v1/chats/parent', { chatId: source, parentChatId: parent });
    const child = fixture.newChatId();
    const created = kind === 'fork'
      ? await fixture.client.forkChat({ sourceChatId: source, chatId: child })
      : await fixture.client.post<ForkRunCommandResponse>('/api/v1/chats/handoff-run', {
          sourceChatId: source, chatId: child, clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(), command: 'Synthetic continuation.',
        });
    if ('turnId' in created && typeof created.turnId === 'string') await fixture.client.waitForTurnTerminal(child, created.turnId);
    expect(created.chat.parentChatId).toBeNull();
    expect(created.chat.lineage).toMatchObject({ sourceChatId: source, kind });
    const before = await fixture.client.getChatSnapshot(child);
    for (const parentChatId of [parent, replacement, null]) {
      const command = await runCli(fixture, ['set-parent', child, parentChatId ?? '--clear', '--json']);
      expect(command, command.stderr).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(command.stdout)).toMatchObject({ parentChatId, changed: true });
      const chat = (await fixture.client.listChats()).sessions.find((entry) => entry.id === child);
      expect(chat?.lineage).toEqual(created.chat.lineage);
      expect(chat?.parentChatId).toBe(parentChatId);
      const byParent = await runCli(fixture, ['chats', '--filter', `parent:${parentChatId ?? replacement}`, '--json']);
      expect(byParent, byParent.stderr).toMatchObject({ exitCode: 0 });
      const bySource = await runCli(fixture, ['chats', '--filter', `source:${source}`, '--json']);
      expect(bySource, bySource.stderr).toMatchObject({ exitCode: 0 });
      expect(bySource.stdout).toContain(child);
      if (parentChatId === null) expect(byParent.stdout).not.toContain(child);
      else expect(byParent.stdout).toContain(child);
      expect(await fixture.client.getChatSnapshot(child)).toMatchObject({
        chat: before.chat, transcript: before.transcript, control: before.control, processingPhase: before.processingPhase,
      });
    }
    await fixture.restartGarcon();
    const restored = (await fixture.client.listChats()).sessions.find((entry) => entry.id === child);
    expect(restored?.lineage).toEqual(created.chat.lineage);
    expect(restored?.parentChatId).toBeNull();
  });
}, 60_000);
