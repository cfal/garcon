import { expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantContents } from '../../support/chat-assertions.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains, waitForVisibleResponse } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

test.each(['session-shape', 'hidden-artifact', 'non-record-artifact'])('rejects native fork %s before publication, deletes its artifact, and allows a fresh fork', async (invalid) => {
  const environment = await startScriptedClaudeTestEnvironment();
  const reply = 'Synthetic native fork source reply';
  environment.model.scriptTurn([claudeText(reply)]);
  try {
    await withIntegrationFixture(`provider-native-fork-validation-${invalid}`, async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const chatId = fixture.newChatId();
      const afterIndex = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId, projectPath: fixture.dirs.project, command: 'Synthetic native fork source prompt',
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({ fixture, chatId: sourceChatId, turnId: turn.turnId, marker: reply, afterIndex });
      await reloadUntilNativeContains(fixture, sourceChatId, reply);
      const source = await fixture.client.getMessages(sourceChatId);
      const chats = await fixture.client.listChats();

      await expect(fixture.client.forkChat({ sourceChatId, chatId })).rejects.toMatchObject({ status: 500 });
      const diagnostics = JSON.parse(await readFile(join(fixture.dirs.root, 'native-fork-diagnostics.json'), 'utf8')) as {
        forks: number; discards: number; discardedPath: string; existedBeforeDiscard: boolean;
      };
      expect(diagnostics).toMatchObject({ forks: 1, discards: 1, existedBeforeDiscard: true });
      expect(diagnostics.discardedPath.startsWith(fixture.dirs.root)).toBe(true);
      await expect(access(diagnostics.discardedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fixture.client.listChats()).toEqual(chats);
      expect(await fixture.client.getMessages(sourceChatId)).toEqual(source);

      await fixture.client.forkChat({ sourceChatId, chatId });
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toContain(reply);
      expect(JSON.parse(await readFile(join(fixture.dirs.root, 'native-fork-diagnostics.json'), 'utf8'))).toMatchObject({ forks: 2, discards: 1 });
      environment.model.assertSettled();
    }, {
      bindAddress: '0.0.0.0', authentication: 'account', serverEnvironment: environment.serverEnvironment,
      preloadModules: [fileURLToPath(new URL('../../support/provider-native-fork-preload.ts', import.meta.url))],
      resolveServerEnvironment: (directories) => ({
        GARCON_TEST_NATIVE_FORK_DIAGNOSTICS: join(directories.root, 'native-fork-diagnostics.json'),
        GARCON_TEST_NATIVE_FORK_INVALID: invalid,
      }),
    });
  } finally {
    environment.dispose();
  }
}, 60_000);
