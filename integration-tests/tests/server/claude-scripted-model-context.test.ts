import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTurnCommandResponse } from '../../../common/chat-command-contracts.js';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { withIntegrationFixture, type IntegrationDirectories } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from '../../support/live-claude.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

test('Claude rejects invalid initial models consistently before creating a chat', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  try {
    await withIntegrationFixture('claude-model-context-start-validation', async (fixture) => {
      const chatId = fixture.newChatId();
      const request = {
        ...liveClaudeStartRequest({ chatId, projectPath: fixture.dirs.project, command: 'Confirm the model.' }),
        model: 'custom[99k]',
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(fixture.client.startChat(request)).rejects.toMatchObject({
          status: 422,
          body: { errorCode: 'VALIDATION_FAILED', retryable: false },
        });
      }
      await expect(fixture.client.getChatSnapshot(chatId)).rejects.toMatchObject({ status: 404 });
      expect(environment.model.requests()).toHaveLength(0);
      expect(fixture.garcon.logs.filter(line => line.includes('Spawning Claude CLI'))).toHaveLength(0);

      // Reusing the rejected request identity proves preflight did not reserve a command or chat.
      const reply = 'The initial model is corrected.';
      environment.model.scriptTurn([claudeText(reply)]);
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat({ ...request, model: 'custom[922k]' });
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor });
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment });
  } finally {
    environment.dispose();
  }
}, 60_000);

test('Claude validates unstarted chat settings before persistence and can start after correction', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  const chatId = '1786120000000003';
  try {
    await withIntegrationFixture('claude-model-context-validation', async (fixture) => {
      await expect(fixture.client.patch('/api/v1/chats/model', { chatId, model: 'custom[99k]' }))
        .rejects.toThrow(/returned 422:.*context suffix/);
      const registry = JSON.parse(await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'));
      expect(registry.sessions[chatId]).toMatchObject({ model: 'custom[1m]', agentSessionId: null });

      const model = 'custom[922k]';
      await fixture.client.patch('/api/v1/chats/model', { chatId, model });
      const reply = 'The corrected model is ready.';
      environment.model.scriptTurn([claudeText(reply)]);
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.runChat({
        ...liveClaudeRunRequest({ chatId, command: 'Confirm the corrected model.' }),
        model,
      });
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor });
      expect(environment.model.requests().at(-1)?.body.model).toBe('custom');
      environment.model.assertSettled();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (dirs) => prepareUnstartedClaudeChat(dirs, chatId),
    });
  } finally {
    environment.dispose();
  }
}, 60_000);

for (const suffix of ['[922k]', '[1m]']) {
  test(`Claude applies the ${suffix} compaction policy through a real tool turn`, async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    const model = `integration-context-model${suffix}`;
    const reply = 'The scripted context turn is complete.';
    const referenceNote = 'Synthetic context entry for the scripted compaction test.';
    const summary = 'The previous turn recorded synthetic reference notes.';
    const expectsCompaction = suffix === '[922k]';
    try {
      // Reported usage exercises the CLI's budgeting without sending a 900K-token fixture.
      const firstReply = 'The initial reference notes are recorded.';
      const historyReply = 'The reference notes are recorded.';
      environment.model.scriptTurn([claudeText(firstReply)]);
      environment.model.scriptTurn([claudeText(historyReply)], { inputTokens: 900_000 });
      if (expectsCompaction) {
        environment.model.scriptTurn([claudeText(summary)]);
      }
      environment.model.scriptTurn([
        claudeToolUse('toolu_context_budget', 'Bash', { command: 'echo context-check' }),
      ]);
      environment.model.scriptTurn([claudeText(reply)]);

      await withIntegrationFixture('claude-model-context-budget', async (fixture) => {
        const chatId = fixture.newChatId();
        const historyCursor = fixture.client.markEvents();
        const historyTurn = await fixture.client.startChat({
          ...liveClaudeStartRequest({
            chatId,
            projectPath: fixture.dirs.project,
            // Mutable history keeps the fake usage from looking like an oversized fixed system prefix.
            command: 'Record these reference notes for a later turn:\n'
              + `${referenceNote}\n`.repeat(4_000),
            permissionMode: 'bypassPermissions',
          }),
          model,
        });
        // Reactive compaction retains the last assistant-led group; an older assistant must remain.
        await waitForVisibleResponse({
          fixture, chatId, turnId: historyTurn.turnId, marker: firstReply, afterIndex: historyCursor,
        });
        const accumulatedCursor = fixture.client.markEvents();
        const accumulated = await fixture.client.runChat({
          ...liveClaudeRunRequest({ chatId, command: 'Acknowledge the recorded reference notes.' }),
          model,
        });
        await waitForVisibleResponse({
          fixture, chatId, turnId: accumulated.turnId, marker: historyReply, afterIndex: accumulatedCursor,
        });
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.runChat({
          ...liveClaudeRunRequest({
            chatId,
            command: 'Run the scripted command, then report completion.',
            permissionMode: 'bypassPermissions',
          }),
          model,
        });
        await waitForVisibleResponse({
          fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor,
        });
        const requests = environment.model.requests();
        expect(requests).toHaveLength(expectsCompaction ? 5 : 4);
        const finalHistory = JSON.stringify(requests.at(-1)?.body.messages);
        if (expectsCompaction) {
          expect(finalHistory).toContain(summary);
          expect(finalHistory).not.toContain(referenceNote);
        } else {
          expect(finalHistory).toContain(referenceNote);
        }
        expect(requests.every(request =>
          request.body.model === 'integration-context-model')).toBe(true);
        environment.model.assertSettled();
      }, {
        serverEnvironment: {
          ...environment.serverEnvironment,
          // The explicit [922k] cap must win; native [1m] preserves this override.
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
        },
      });
    } finally {
      environment.dispose();
    }
  }, 60_000);
}

test('Claude preserves the native session and only restarts when the context cap changes', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  try {
    await withIntegrationFixture('claude-model-context-switch', async (fixture) => {
      const chatId = fixture.newChatId();
      let sessionId: string | undefined;
      const selections = [
        { model: 'first[922k]', expectedLaunches: 1 },
        { model: 'second[922k]', expectedLaunches: 1 },
        { model: 'second[850k]', expectedLaunches: 2 },
        { model: 'third[1m]', expectedLaunches: 3 },
      ];
      for (const [index, { model, expectedLaunches }] of selections.entries()) {
        const reply = `Scripted model switch ${index} complete.`;
        environment.model.scriptTurn([claudeText(reply)]);
        const cursor = fixture.client.markEvents();
        const command = `Respond to scripted model switch ${index}.`;
        let turn: AgentTurnCommandResponse;
        if (index === 0) {
          turn = await fixture.client.startChat({
            ...liveClaudeStartRequest({ chatId, command, projectPath: fixture.dirs.project }),
            model,
          });
        } else {
          await fixture.client.patch('/api/v1/chats/model', { chatId, model });
          turn = await fixture.client.runChat({ ...liveClaudeRunRequest({ chatId, command }), model });
        }
        await waitForVisibleResponse({
          fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor,
        });
        const persisted = await waitForPersistedNativeSession({
          directories: fixture.dirs, chatId, agentId: 'claude',
        });
        if (!persisted.agentSessionId) throw new Error('Claude session was not persisted.');
        if (sessionId === undefined) sessionId = persisted.agentSessionId;
        expect(persisted.agentSessionId).toBe(sessionId);
        expect((await fixture.client.getChatSnapshot(chatId)).chat.model).toBe(model);
        expect(environment.model.requests().at(-1)?.body.model).toBe(model.split('[')[0]);
        const launches = fixture.garcon.logs.filter(line => line.includes('Spawning Claude CLI'));
        expect(launches).toHaveLength(expectedLaunches);
      }
      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'user-message')).toHaveLength(4);
      await expect(fixture.client.patch('/api/v1/chats/model', { chatId, model: 'third[99k]' }))
        .rejects.toThrow(/returned 422:.*context suffix/);
      expect((await fixture.client.getChatSnapshot(chatId)).chat.model).toBe('third[1m]');
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment });
  } finally {
    environment.dispose();
  }
}, 60_000);

async function prepareUnstartedClaudeChat(dirs: IntegrationDirectories, chatId: string): Promise<void> {
  await writeFile(
    join(dirs.workspace, 'workspace-version.json'),
    JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }),
  );
  await writeFile(join(dirs.workspace, 'chats.json'), JSON.stringify({
    version: 5,
    sessions: {
      [chatId]: {
        agentId: 'claude',
        model: 'custom[1m]',
        projectPath: dirs.project,
        agentOwnershipEpoch: '00000000-0000-4000-8000-000000000003',
        agentSessionId: null,
        nativeSession: null,
        nativeSeedReceipt: null,
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
        agentSettingsById: {},
        permissionMode: 'default',
        thinkingMode: 'low',
        tags: [],
        carryOverSegments: [],
        carryOverMigrationQuarantine: null,
        lastReadAt: null,
      },
    },
  }));
}
