import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptExportResponse } from '../../../common/chat-export-contracts.js';
import type { ScheduledPromptsMutationResponse } from '../../../common/scheduled-prompts.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`Shell source, cwd failure, and incomplete export regressions (${executionBackend})`, async () => {
    await withIntegrationFixture(`shell-review-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const start = async (command: string, chatId = fixture.newChatId()) => {
        const receipt = await client.startChat({
          chatId, agentId: 'shell', model: 'bash', projectPath: fixture.executionDirs.project,
          permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
          origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command,
        });
        return receipt;
      };
      const titlePrefix = '#' + 'x'.repeat(98);
      const initial = await start(titlePrefix + '\u{1f600}\nprintf "%s|%s|%s" "$#" "${1-unset}" "${2-unset}"');
      expect((await client.waitForTurnTerminal(initial.chatId, initial.turnId)).type).toBe('agent-run-finished');
      await client.waitForProcessing(initial.chatId, false);
      expect((await client.listChats()).sessions.find(chat => chat.id === initial.chatId)?.title).toBe(titlePrefix);
      expect((await client.getMessages(initial.chatId)).messages.some(row =>
        row.message.type === 'command-output' && row.message.content.endsWith('0|unset|unset'))).toBe(true);

      const corrupted = await client.runChat({ chatId: initial.chatId,
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        command: 'touch ready; while [ ! -e release ]; do sleep 0.01; done; report="$(dirname "${BASH_SOURCE[0]}")/cwd"; rm "$report"; mkfifo "$report"; exit 0',
      });
      const readyPath = join(fixture.executionDirs.project, 'ready');
      const deadline = Date.now() + 5000;
      while (!await Bun.file(readyPath).exists() && Date.now() < deadline) await Bun.sleep(10);
      expect(await Bun.file(readyPath).exists()).toBe(true);
      await client.enqueueNew(initial.chatId, 'touch must-not-run');
      await writeFile(join(fixture.executionDirs.project, 'release'), '');
      expect((await client.waitForTurnTerminal(initial.chatId, corrupted.turnId)).type).toBe('agent-run-failed');
      await client.waitForProcessing(initial.chatId, false);
      expect((await client.getExecutionControl(initial.chatId)).queue).toMatchObject({
        pause: { kind: 'turn-failed' }, entries: [expect.anything()],
      });
      expect(await Bun.file(join(fixture.executionDirs.project, 'must-not-run')).exists()).toBe(false);
      expect((await client.listChats()).sessions.find(chat => chat.id === initial.chatId)?.projectPath)
        .toBe(fixture.executionDirs.project);

      const incomplete = await start('/md printf "# incomplete heading"; sleep 5 &');
      expect((await client.waitForTurnTerminal(incomplete.chatId, incomplete.turnId)).type).toBe('agent-run-failed');
      await client.waitForProcessing(incomplete.chatId, false);
      const output = (await client.getMessages(incomplete.chatId)).messages.find(row =>
        row.message.type === 'command-output' && row.message.channel === 'stdout')?.message;
      const stdout = output?.type === 'command-output' ? output.content : undefined;
      expect(stdout).toEndWith('# incomplete heading');
      const exported = await client.get<TranscriptExportResponse>(
        `/api/v1/chats/export?chatId=${incomplete.chatId}&format=markdown&exclude=diagnostics`,
      );
      expect(exported.document).toContain('```text\n' + stdout + '\n```');
      await client.reloadChat(incomplete.chatId);
      const reloaded = await client.get<TranscriptExportResponse>(
        `/api/v1/chats/export?chatId=${incomplete.chatId}&format=markdown`,
      );
      expect(reloaded.document).toContain('```text\n' + stdout + '\n```');

      const malformedId = fixture.newChatId();
      expect(await rejectionOf(start(JSON.parse('"touch must-not-execute; # \\ud800"'), malformedId)))
        .toMatchObject({ status: 422, body: { errorCode: 'INVALID_SETTINGS', retryable: false } });
      expect((await client.waitForTurnTerminal(malformedId)).type).toBe('agent-run-failed');
      expect((await client.listChats()).sessions.some(chat => chat.id === malformedId)).toBe(false);
      expect(await Bun.file(join(fixture.executionDirs.project, 'must-not-execute')).exists()).toBe(false);
    }, { executionBackend });
  }, 60_000);
}

test('existing-chat schedules survive cold controller startup without remote inventory', async () => {
  await withIntegrationFixture('shell-offline-schedule', async fixture => {
    const chatId = fixture.newChatId();
    const initial = await fixture.client.startChat({ chatId, agentId: 'shell', model: 'sh',
      projectPath: fixture.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
      agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
      clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'true' });
    await fixture.client.waitForTurnTerminal(chatId, initial.turnId);
    await fixture.client.waitForProcessing(chatId, false);
    const remote = await fixture.client.post<{ id: string }>('/api/v1/executors', {
      label: 'Synthetic offline executor', direction: 'executor-connects', noTls: true,
    });
    await fixture.restartGarcon({ beforeStart: async () => {
      // Seeds a durable remote chat before any inventory can arrive at the replacement controller.
      const path = join(fixture.dirs.workspace, 'chats.json');
      const registry = JSON.parse(await readFile(path, 'utf8'));
      registry.sessions[chatId].executorId = remote.id;
      await writeFile(path, JSON.stringify(registry));
    } });
    const { client } = fixture;
    const definition = { schedule: { type: 'once' as const, runAtUtc: '2099-01-01T00:00:00.000Z' },
      target: { type: 'existing-chat' as const, chatId, busyBehavior: 'queue' as const },
      prompt: '  /usr/bin/printf "{{chat_id}}"  \n' };
    const created = await client.createScheduledPrompt({ expectedRevision: (await client.getScheduledPrompts()).revision,
      scheduledPrompt: definition });
    expect(created.snapshot.prompts[0]?.prompt).toBe(definition.prompt);
    const edited = await client.put<ScheduledPromptsMutationResponse>('/api/v1/scheduled-prompts', {
      id: created.snapshot.prompts[0]!.id, expectedRevision: created.snapshot.revision,
      scheduledPrompt: { ...definition, prompt: `${definition.prompt}\n` },
    });
    expect(edited.snapshot.prompts[0]?.prompt).toBe(`${definition.prompt}\n`);
  });
}, 60_000);
