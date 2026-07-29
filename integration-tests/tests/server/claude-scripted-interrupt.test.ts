import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assistantContents } from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectStoppedTurnEventOrder,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  liveClaudeRunRequest,
  liveClaudeStartRequest,
} from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude interrupt lifecycle', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('stops an active command and preserves later delivery', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const stoppedReply = marker('SHOULD_NOT_COMPLETE');
    const recoveryReply = marker('RECOVERY_REPLY');
    const stoppedPrompt = marker('STOPPED_PROMPT');
    const recoveryPrompt = marker('RECOVERY_PROMPT');
    const startedFile = '.claude-scripted-stop-started';
    const command = `touch ${startedFile} && sleep 30`;
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_stopped', 'Bash', { command }),
    ]);

    await withIntegrationFixture('claude-scripted-interrupt', async (fixture) => {
      const chatId = fixture.newChatId();
      const active = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: stoppedPrompt,
        permissionMode: 'bypassPermissions',
      }));
      if (!active.turnId) throw new Error('Claude start response omitted its turn id.');
      await waitForFile(join(fixture.dirs.project, startedFile));

      const stopCursor = fixture.client.markEvents();
      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(stopped.outcome).toBe('interrupt-requested');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: stopCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
        .not.toContain(stoppedReply);

      testEnvironment.model.scriptTurn([claudeText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: recoveryPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`Claude never created ${path}.`);
}
