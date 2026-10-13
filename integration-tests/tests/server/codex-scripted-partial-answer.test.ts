import { expect, test } from 'bun:test';
import { parseAgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage, codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('Codex partial answers remain visible without becoming terminal response text', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    await withIntegrationFixture('codex-scripted-partial-answer', async (fixture) => {
      const chatId = fixture.newChatId();
      const expectedContents: string[] = [];
      for (const [start, hasFinal] of [[true, true], [false, true], [false, false]] as const) {
        const label = start ? 'initial' : hasFinal ? 'resumed' : 'partial-only';
        const final = `Synthetic ${label} final answer.`;
        const partial = `Synthetic ${label} nonterminal answer.`;
        environment.model.scriptTurn([
          ...(hasFinal ? [codexFinalAnswerMessage(final)] : []),
          { ...codexAssistantMessage(partial), phase: 'partial_answer' },
        ]);
        const cursor = fixture.client.markEvents();
        const accepted = start
          ? await fixture.client.startChat(liveCodexStartRequest({
              chatId, projectPath: fixture.executionDirs.project, command: 'Return the synthetic answer.',
            }))
          : await fixture.client.runChat(liveCodexRunRequest({ chatId, command: 'Return the next synthetic answer.' }));
        await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, { afterIndex: cursor, timeoutMs: 60_000 });
        const receipt = parseAgentTurnReceipt(await fixture.client.get(
          `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${accepted.turnId}`,
        ));
        expect(receipt).toMatchObject({ state: 'completed', output: hasFinal
          ? { availability: 'available', completeness: 'complete', text: final }
          : { availability: 'unavailable', reason: 'no-final-response' },
        });
        const transcript = assistantContents((await fixture.client.getMessages(chatId)).messages);
        expect(transcript.filter((text) => text === final)).toHaveLength(hasFinal ? 1 : 0);
        expect(transcript.filter((text) => text === partial)).toHaveLength(1);
        expectedContents.push(...(hasFinal ? [final] : []), partial);
      }
      await fixture.client.reloadChat(chatId);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toEqual(expectedContents);
      environment.model.assertSettled();
    }, environment);
  } finally {
    await environment.dispose();
  }
}, 120_000);
