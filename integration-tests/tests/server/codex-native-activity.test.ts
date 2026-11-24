import { expect, test } from 'bun:test';
import { appendFile, readFile } from 'node:fs/promises';
import type { ChatOperationalNoticeMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { throwingRejectionOf } from '../../support/promise-assertions.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('keeps Codex activation quiet for incomparable native timestamps while preserving Reload', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    await withIntegrationFixture('codex-native-activity', async (fixture) => {
      const chatId = fixture.newChatId();
      const answer = 'Synthetic native activity answer.';
      environment.model.scriptTurn([codexFinalAnswerMessage(answer)]);
      const turnCursor = fixture.client.markEvents();
      const accepted = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.executionDirs.project,
        command: 'Synthetic native activity prompt.',
      }));
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: turnCursor,
        timeoutMs: 60_000,
      });
      await reloadUntilNativeContains(fixture, chatId, answer);
      const before = await fixture.client.getMessages(chatId);
      const native = await waitForPersistedNativeSession({
        directories: fixture.dirs, chatId, agentId: 'codex',
      });
      const nativePath = native.nativeSession?.value.path;
      if (typeof nativePath !== 'string') throw new Error('Synthetic native path is missing.');
      const metadata = JSON.parse((await readFile(nativePath, 'utf8')).split('\n', 1)[0]!);
      expect(metadata.payload.history_mode).toBe('paginated');

      await appendFile(nativePath, `${JSON.stringify({
        type: 'response_item',
        timestamp: '2099-01-01T00:00:00.000Z',
        payload: {
          type: 'function_call', name: 'wait', call_id: 'synthetic-internal-wait',
          arguments: JSON.stringify({ cell_id: 'synthetic-cell' }),
        },
      })}\n`);
      const activationCursor = fixture.client.markEvents();
      expect(await fixture.client.getMessages(chatId, { purpose: 'activation' })).toEqual(before);
      // Covers the detector's complete five-second probe deadline before asserting silence.
      expect(await throwingRejectionOf(fixture.client.waitForEvent(
        (event): event is ChatOperationalNoticeMessage => event.type === 'chat-operational-notice'
          && event.chatId === chatId && event.detail?.type === 'native-transcript-drift',
        'unexpected Codex native drift warning',
        { afterIndex: activationCursor, timeoutMs: 6_000 },
      ))).toThrow('Timed out waiting for unexpected Codex native drift warning.');

      await fixture.client.reloadChat(chatId);
      const reloaded = await fixture.client.getMessages(chatId);
      expect(reloaded.transcriptViewId).not.toBe(before.transcriptViewId);
      expect(assistantContents(reloaded.messages)).toEqual([answer]);
      environment.model.assertSettled();
    }, environment);
  } finally {
    await environment.dispose();
  }
}, 90_000);
