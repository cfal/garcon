import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('resumes a legacy active goal without native goal tools or autonomous turns', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  environment.model.scriptTurn([codexAssistantMessage('SCRIPTED_GOAL_INITIAL')]);
  try {
    await withIntegrationFixture('codex-legacy-goal', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'Establish a native thread.',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: first.turnId, marker: 'SCRIPTED_GOAL_INITIAL', afterIndex: firstCursor,
      });
      const native = await waitForPersistedNativeSession({
        directories: fixture.dirs, chatId, agentId: 'codex',
      });
      const goalDatabasePath = join(fixture.dirs.home, '.codex', 'goals_1.sqlite');
      await fixture.restartGarcon({
        beforeStart: async () => {
          // Matches the pinned Codex goal schema; only this isolated fixture DB is changed.
          // https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/state/goals_migrations/0001_thread_goals.sql#L1-L19
          using database = new Database(goalDatabasePath, { readwrite: true });
          database.query(`INSERT INTO thread_goals
            (thread_id, goal_id, objective, status, created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, 'active', 1000, 1000)`)
            .run(native.agentSessionId, 'synthetic-legacy-goal', 'Continue the synthetic legacy goal.');
        },
      });

      environment.model.scriptTurn([codexAssistantMessage('SCRIPTED_GOAL_RESUMED')]);
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveCodexRunRequest({
        chatId, command: 'Run only this explicit user turn.',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: resumed.turnId, marker: 'SCRIPTED_GOAL_RESUMED', afterIndex: resumedCursor,
      });
      // The native idle continuation is asynchronous after turn/completed.
      await Bun.sleep(1_000);
      const requests = environment.model.requests();
      expect(requests.map((request) => request.lastUserText)).toEqual([
        'Establish a native thread.', 'Run only this explicit user turn.',
      ]);
      for (const request of requests) {
        const tools = request.body.tools;
        if (!Array.isArray(tools)) throw new Error('Codex did not send a tool catalog.');
        const names = tools.map((tool) => tool.name);
        expect(names).not.toContain('get_goal');
        expect(names).not.toContain('create_goal');
        expect(names).not.toContain('update_goal');
      }
      using database = new Database(goalDatabasePath, { readonly: true });
      expect(database.query('SELECT status FROM thread_goals WHERE thread_id = ?')
        .get(native.agentSessionId)).toEqual({ status: 'active' });
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      async prepareWorkspace(directories) {
        await environment.prepareWorkspace(directories);
        await appendFile(join(directories.home, '.codex', 'config.toml'), '\n[features]\ngoals = true\n');
      },
    });
  } finally {
    await environment.dispose();
  }
}, 90_000);
