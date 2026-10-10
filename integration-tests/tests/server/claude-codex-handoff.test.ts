import { expect, test } from 'bun:test';
import type { StartChatCommandRequest } from '../../../common/chat-command-contracts.js';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import { expectedCarriedInput } from '../../support/carried-context.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { type IntegrationFixture, withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('carries history once across Claude to Codex to Claude and drains the destination queue', async () => {
  const claude = await startScriptedClaudeTestEnvironment();
  try {
    const codex = await startScriptedCodexTestEnvironment();
    try {
      const sourcePrompt = 'SYNTHETIC_CLAUDE_SOURCE';
      const sourceReply = 'SYNTHETIC_CLAUDE_SOURCE_REPLY';
      const codexPrompt = 'SYNTHETIC_CODEX_HANDOFF';
      const codexReply = 'SYNTHETIC_CODEX_HANDOFF_REPLY';
      const runningPrompt = 'SYNTHETIC_CODEX_RUNNING';
      const runningReply = 'SYNTHETIC_CODEX_RUNNING_REPLY';
      const queuedPrompt = 'SYNTHETIC_CODEX_QUEUED';
      const queuedReply = 'SYNTHETIC_CODEX_QUEUED_REPLY';
      const returnPrompt = 'SYNTHETIC_CLAUDE_RETURN';
      const returnReply = 'SYNTHETIC_CLAUDE_RETURN_REPLY';
      claude.model.scriptTurn([claudeText(sourceReply)]);
      claude.model.scriptTurn([claudeText(returnReply)]);
      codex.model.scriptTurn([codexAssistantMessage(codexReply)]);
      const running = codex.model.scriptHeldTurn([codexAssistantMessage(runningReply)]);
      codex.model.scriptTurn([codexAssistantMessage(queuedReply)]);

      await withIntegrationFixture('claude-codex-handoff', async (fixture) => {
        const chatId = fixture.newChatId();
        const source = liveClaudeStartRequest({
          chatId, projectPath: fixture.dirs.project, command: sourcePrompt,
        });
        const destination = liveCodexStartRequest({
          chatId, projectPath: fixture.dirs.project, command: codexPrompt,
        });
        const first = await fixture.client.startChat(source);
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        const viewId = (await fixture.client.getMessages(chatId)).transcriptViewId;

        const switched = await handoff(fixture, destination, codexPrompt);
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, switched.turnId, {
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        const codexInput = codex.model.requests()[0]?.lastUserText ?? '';
        const codexPrefix = expectedCarriedInput([sourcePrompt, sourceReply], '');
        expect(codexInput).toContain(`${codexPrefix}${codexPrompt}`);
        expect(codexInput.split(codexPrefix)).toHaveLength(2);
        expect(codexInput.split(codexPrompt)).toHaveLength(2);

        const active = await fixture.client.runChat({
          chatId, command: runningPrompt,
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        });
        expect((await running.requested).lastUserText).toBe(runningPrompt);
        const queueCursor = fixture.client.markEvents();
        const queued = await fixture.client.enqueueNew(chatId, queuedPrompt);
        expect(queued.control.queue.entries.map(entry => entry.content)).toEqual([queuedPrompt]);
        running.release();
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, active.turnId, {
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        const input = await fixture.client.waitForCommittedUserInput(chatId, queuedPrompt, {
          afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, undefined, {
          afterIndex: fixture.client.events().lastIndexOf(input) + 1,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
        expect(codex.model.requests().map(request => request.lastUserText).slice(1))
          .toEqual([runningPrompt, queuedPrompt]);

        const returned = await handoff(fixture, source, returnPrompt);
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, returned.turnId, {
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        const returnInput = claude.model.requests().at(-1)?.lastUserText ?? '';
        const returnPrefix = expectedCarriedInput([
          sourcePrompt, sourceReply, codexPrompt, codexReply,
          runningPrompt, runningReply, queuedPrompt, queuedReply,
        ], '');
        expect(returnInput).toContain(`${returnPrefix}${returnPrompt}`);
        expect(returnInput.split(returnPrefix)).toHaveLength(2);
        expect(returnInput.split(returnPrompt)).toHaveLength(2);
        const history = await fixture.client.getMessages(chatId);
        expect(history.transcriptViewId).toBe(viewId);
        expect(userContents(history.messages)).toEqual([
          sourcePrompt, codexPrompt, runningPrompt, queuedPrompt, returnPrompt,
        ]);
        expect(assistantContents(history.messages)).toEqual([
          sourceReply, codexReply, runningReply, queuedReply, returnReply,
        ]);
        expect(messagesOfType(history.messages, 'agent-switch')).toHaveLength(2);
        expect(claude.model.requests()).toHaveLength(2);
        expect(codex.model.requests()).toHaveLength(3);
        claude.model.assertSettled();
        codex.model.assertSettled();
      }, {
        serverEnvironment: { ...claude.serverEnvironment, ...codex.serverEnvironment },
        prepareWorkspace: codex.prepareWorkspace,
      });
    } finally {
      await codex.dispose();
    }
  } finally {
    claude.dispose();
  }
}, 120_000);

async function handoff(fixture: IntegrationFixture, target: StartChatCommandRequest, command: string) {
  if (!target.model) throw new Error('Synthetic handoff model is required');
  const source = await fixture.client.getChatSnapshot(target.chatId);
  return fixture.client.runChat({
    chatId: target.chatId, command,
    clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
    handoff: {
      expectedAgentOwnershipEpoch: source.chat.agentOwnershipEpoch,
      target: {
        agentId: target.agentId, model: target.model,
        permissionMode: target.permissionMode, thinkingMode: target.thinkingMode,
        agentSettings: target.agentSettings,
      },
    },
  });
}
