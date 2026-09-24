import { expect, test } from 'bun:test';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeText } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from '../../support/live-claude.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

test('retries a refused project-path change after restoring native history without restarting', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  environment.model.scriptTurn([claudeText('SCRIPTED_PATH_INITIAL')]);
  environment.model.scriptTurn([claudeText('SCRIPTED_PATH_RESUMED')]);
  try {
    await withIntegrationFixture('claude-path-retry', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'Establish the native history.',
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: first.turnId, marker: 'SCRIPTED_PATH_INITIAL', afterIndex: firstCursor,
      });
      const binding = await waitForPersistedNativeSession({
        directories: fixture.dirs, chatId, agentId: 'claude',
      });
      const nativePath = binding.nativeSession?.value.path;
      if (typeof nativePath !== 'string') throw new Error('Claude native path was not persisted.');
      const backup = `${nativePath}.held`;
      await fixture.restartGarcon({ beforeStart: () => rename(nativePath, backup) });

      const nextProjectPath = join(fixture.dirs.project, 'destination');
      await mkdir(nextProjectPath);
      await expect(fixture.client.updateProjectPath({ chatId, projectPath: nextProjectPath }))
        .rejects.toMatchObject({
          status: 409,
          body: { errorCode: 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED' },
        });
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({ projectPath: fixture.dirs.project });

      await rename(backup, nativePath);
      await expect(fixture.client.updateProjectPath({ chatId, projectPath: nextProjectPath }))
        .resolves.toMatchObject({ success: true, projectPath: nextProjectPath });
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: 'Resume in the corrected destination.',
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: resumed.turnId, marker: 'SCRIPTED_PATH_RESUMED', afterIndex: resumedCursor,
      });
      const relocated = await waitForPersistedNativeSession({
        directories: fixture.dirs, chatId, agentId: 'claude',
      });
      expect(relocated.agentSessionId).toBe(binding.agentSessionId);
      expect(relocated.nativeSession?.value.path).not.toBe(nativePath);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment });
  } finally {
    environment.dispose();
  }
}, 60_000);
