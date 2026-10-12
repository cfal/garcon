import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAppServerClient } from '../../../server-agents/codex/src/agents/codex/app-server/client.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage, codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { isolatedEnvironment } from '../../support/garcon-process.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains } from '../../support/live-agent.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('pages materialized Codex history and hydrates nested native forks without changing the source', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    await withIntegrationFixture('codex-scripted-pages', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const answers = Array.from({ length: 3 }, (_, turn) => [
        ...Array.from({ length: 55 }, (_, item) => `Synthetic turn ${turn} progress ${item}.`),
        `Synthetic turn ${turn} final.`,
      ]);
      const prompts = answers.map((_, turn) => `Synthetic prompt ${turn}.`);
      for (const [turn, texts] of answers.entries()) {
        environment.model.scriptTurn(texts.map((text, index) => index === texts.length - 1
          ? codexFinalAnswerMessage(text)
          : { ...codexAssistantMessage(text), phase: 'commentary' }));
        const cursor = fixture.client.markEvents();
        const accepted = turn === 0
          ? await fixture.client.startChat(liveCodexStartRequest({
              chatId: sourceChatId, projectPath: fixture.executionDirs.project, command: prompts[turn]!,
            }))
          : await fixture.client.runChat(liveCodexRunRequest({ chatId: sourceChatId, command: prompts[turn]! }));
        await fixture.client.waitForTurnTerminal(sourceChatId, accepted.turnId, { afterIndex: cursor, timeoutMs: 60_000 });
      }
      await reloadUntilNativeContains(fixture, sourceChatId, answers[2]!.at(-1)!);
      const source = await fixture.client.getMessages(sourceChatId, { limit: 500 });
      expect(assistantContents(source.messages)).toEqual(answers.flat());
      expect(userContents(source.messages)).toEqual(prompts);
      const sourceNative = await nativeSession(fixture, sourceChatId);
      const sourceBefore = await readFile(sourceNative.path, 'utf8');
      expect(sessionMetadata(sourceBefore).history_mode).toBe('paginated');

      const nativeEnv = isolatedEnvironment(fixture.executionDirs.home, {
        ...environment.serverEnvironment, CODEX_HOME: join(fixture.executionDirs.home, '.codex'),
      });
      const codex = new CodexAppServerClient({
        resolveCommand: async () => environment.serverEnvironment.GARCON_CODEX_CLI!,
        spawn: (command, args) => Bun.spawn([command, ...args], {
          env: nativeEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        }),
      });
      try {
        expect((await codex.connect()).codexHome).toBe(nativeEnv.CODEX_HOME);
        const turnIds: string[] = [];
        let cursor: string | null = null;
        do {
          const page = await codex.listThreadTurns({
            threadId: sourceNative.id, cursor, limit: 1, sortDirection: 'asc', itemsView: 'notLoaded',
          });
          expect(page.data).toHaveLength(1);
          expect(page.data[0]!.itemsView).toBe('notLoaded');
          expect(page.data[0]!.items).toEqual([]);
          turnIds.push(page.data[0]!.id);
          expect(page.nextCursor).not.toBe(cursor ?? '');
          cursor = page.nextCursor;
        } while (cursor);
        expect(new Set(turnIds).size).toBe(3);

        const itemTurnIds: string[] = [];
        const itemIds: string[] = [];
        let pages = 0;
        do {
          const page = await codex.listThreadItems({
            threadId: sourceNative.id, cursor, limit: 100, sortDirection: 'asc',
          });
          expect(page.data.length).toBeGreaterThan(0);
          expect(page.data.length).toBeLessThanOrEqual(100);
          itemTurnIds.push(...page.data.map((entry) => entry.turnId));
          itemIds.push(...page.data.map((entry) => `${entry.turnId}:${entry.item.id}`));
          cursor = page.nextCursor;
          pages += 1;
          expect(pages).toBeLessThan(10);
        } while (cursor);
        expect(pages).toBeGreaterThan(1);
        expect([...new Set(itemTurnIds)]).toEqual(turnIds);
        expect(new Set(itemIds).size).toBe(itemIds.length);
      } finally {
        await codex.shutdown();
      }

      const anchor = source.messages.find((entry) => (
        entry.message.type === 'assistant-message' && entry.message.content === answers[1]![0]
      ));
      if (!anchor) throw new Error('Synthetic fork anchor is missing.');
      const childChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId, chatId: childChatId,
        transcriptViewId: source.transcriptViewId, upToOrdinal: anchor.ordinal,
      });
      const inheritedAnswers = answers.slice(0, 2).flat();
      expect(assistantContents((await fixture.client.getMessages(childChatId, { limit: 500 })).messages))
        .toEqual(inheritedAnswers);
      const childNative = await nativeSession(fixture, childChatId);
      expect(childNative.id).not.toBe(sourceNative.id);
      expect(sessionMetadata(await readFile(childNative.path, 'utf8')).history_base)
        .toMatchObject({ thread_id: sourceNative.id });

      const branchAnswer = 'Synthetic branch final.';
      environment.model.scriptTurn((request) => {
        const context = JSON.stringify(request.body);
        expect(context).toContain(answers[1]!.at(-1)!);
        expect(context).not.toContain(prompts[2]!);
        return [codexFinalAnswerMessage(branchAnswer)];
      });
      const branchCursor = fixture.client.markEvents();
      const branch = await fixture.client.runChat(liveCodexRunRequest({ chatId: childChatId, command: 'Synthetic branch prompt.' }));
      await fixture.client.waitForTurnTerminal(childChatId, branch.turnId, { afterIndex: branchCursor, timeoutMs: 60_000 });
      await reloadUntilNativeContains(fixture, childChatId, branchAnswer);
      const grandchildChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId: childChatId, chatId: grandchildChatId });
      const grandchildNative = await nativeSession(fixture, grandchildChatId);
      expect(grandchildNative.id).not.toBe(childNative.id);
      expect(sessionMetadata(await readFile(grandchildNative.path, 'utf8')).history_base)
        .toMatchObject({ thread_id: childNative.id });
      await fixture.client.reloadChat(grandchildChatId);
      expect(assistantContents((await fixture.client.getMessages(grandchildChatId, { limit: 500 })).messages))
        .toEqual([...inheritedAnswers, branchAnswer]);

      await fixture.restartGarcon();
      await fixture.client.reloadChat(grandchildChatId);
      expect(assistantContents((await fixture.client.getMessages(grandchildChatId, { limit: 500 })).messages))
        .toEqual([...inheritedAnswers, branchAnswer]);
      const nested = await fixture.client.getMessages(grandchildChatId, { limit: 500 });
      const inheritedAnchor = nested.messages.find((entry) => (
        entry.message.type === 'assistant-message' && entry.message.content === answers[1]![0]
      ));
      if (!inheritedAnchor) throw new Error('Synthetic inherited fork anchor is missing.');
      const nestedPointChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId: grandchildChatId, chatId: nestedPointChatId,
        transcriptViewId: nested.transcriptViewId, upToOrdinal: inheritedAnchor.ordinal,
      });
      expect(assistantContents((await fixture.client.getMessages(nestedPointChatId, { limit: 500 })).messages))
        .toEqual(inheritedAnswers);
      expect((await nativeSession(fixture, nestedPointChatId)).id).not.toBe(grandchildNative.id);
      expect(assistantContents((await fixture.client.getMessages(sourceChatId, { limit: 500 })).messages))
        .toEqual(answers.flat());
      expect(await readFile(sourceNative.path, 'utf8')).toBe(sourceBefore);
      environment.model.assertSettled();
    }, environment);
  } finally {
    await environment.dispose();
  }
}, 180_000);

async function nativeSession(fixture: IntegrationFixture, chatId: string): Promise<{ id: string; path: string }> {
  const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
  const path = native.nativeSession?.value.path;
  if (!native.agentSessionId || typeof path !== 'string') throw new Error('Synthetic native session is missing.');
  return { id: native.agentSessionId, path };
}

function sessionMetadata(jsonl: string): Record<string, unknown> {
  const first = JSON.parse(jsonl.split('\n', 1)[0]!) as { type: string; payload: Record<string, unknown> };
  expect(first.type).toBe('session_meta');
  return first.payload;
}
