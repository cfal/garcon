import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage, codexExecCommandCall } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('Codex relocates without native preparation and resumes the same session after restart', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  for (const phase of ['initial', 'relocated', 'restarted']) {
    environment.model.scriptTurn([codexExecCommandCall(`call_${phase}`, 'pwd')]);
    environment.model.scriptTurn([codexAssistantMessage(`Synthetic ${phase} reply.`)]);
  }
  try {
    await withIntegrationFixture('codex-scripted-project-path-relocation', async (fixture) => {
      const projectA = join(fixture.dirs.project, 'a');
      const projectB = join(fixture.dirs.project, 'b');
      await Promise.all([mkdir(projectA), mkdir(projectB)]);
      const chatId = fixture.newChatId();
      const first = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: projectA, command: 'Synthetic initial input.', permissionMode: 'bypassPermissions',
      }));
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe('agent-run-finished');
      const binding = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
      const initial = await fixture.client.getMessages(chatId);

      expect(await fixture.client.updateProjectPath({ chatId, projectPath: projectB })).toMatchObject({
        success: true, chatId, projectPath: projectB, previousProjectPath: projectA,
      });
      const catalog = (await fixture.client.listAgentCatalog()).agents.find((entry) => entry.id === 'codex');
      expect(catalog?.supportsUpdateProjectPath).toBe(true);

      for (const phase of ['relocated', 'restarted']) {
        if (phase === 'restarted') await fixture.restartGarcon();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.runChat(liveCodexRunRequest({
          chatId, command: `Synthetic ${phase} input.`, permissionMode: 'bypassPermissions',
        }));
        expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, { afterIndex: cursor })).type)
          .toBe('agent-run-finished');
        const current = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
        expect(current).toMatchObject({ projectPath: projectB, agentSessionId: binding.agentSessionId });
        expect(current.nativeSession).toEqual(binding.nativeSession);
      }

      const history = await fixture.client.getMessages(chatId);
      expect(history.transcriptViewId).toBe(initial.transcriptViewId);
      expect(userContents(history.messages)).toEqual([
        'Synthetic initial input.', 'Synthetic relocated input.', 'Synthetic restarted input.',
      ]);
      expect(assistantContents(history.messages)).toEqual([
        'Synthetic initial reply.', 'Synthetic relocated reply.', 'Synthetic restarted reply.',
      ]);
      const requests = environment.model.requests();
      expect(requests).toHaveLength(6);
      for (const [index, phase, project] of [
        [1, 'initial', projectA], [3, 'relocated', projectB], [5, 'restarted', projectB],
      ] as const) {
        const output = requests[index]?.functionCallOutputs.find((entry) => entry.callId === `call_${phase}`);
        expect(output?.output).toContain(project);
      }
      environment.model.assertSettled();
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace,
    });
  } finally {
    await environment.dispose();
  }
}, 60_000);
