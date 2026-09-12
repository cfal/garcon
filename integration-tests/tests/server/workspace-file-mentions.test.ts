import { expect, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage, codexExecCommandCall } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

const placementFailurePreload = fileURLToPath(new URL('../../support/file-mention-placement-preload.ts', import.meta.url));

test.each(['available', 'unavailable'] as const)('start and resume preserve authored input with %s mention placement', async (placement) => {
  await withIntegrationFixture('workspace-file-mentions', async (fixture) => {
    const projectA = join(fixture.dirs.project, 'a');
    const projectB = join(fixture.dirs.project, 'b');
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    await Promise.all([
      writeFile(join(projectA, 'notes.txt'), 'Synthetic source file body.'),
      writeFile(join(projectB, 'notes.txt'), 'Synthetic destination file body.'),
      symlink(join(projectA, 'notes.txt'), join(projectB, 'outside.txt')),
    ]);
    const chatId = fixture.newChatId();
    const agent = fixture.directAgents.openAi;
    const prompts = ['Inspect @notes.txt.', 'Recheck @notes.txt and @outside.txt.'];
    for (const phase of [0, 1] as const) {
      if (phase === 1) await fixture.client.updateProjectPath({ chatId, projectPath: projectB });
      const held = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
      const cursor = fixture.client.markEvents();
      try {
        const turn = phase === 0
          ? await fixture.client.startDirectChat({ chatId, agent, projectPath: projectA, content: prompts[phase]! })
          : await fixture.client.runDirectChat({ chatId, agent, content: prompts[phase]! });
        const request = await held.received;
        expect(request.lastUserText).toContain(prompts[phase]!);
        const expectedContext = phase === 0 ? 'Synthetic source file body.' : 'Synthetic destination file body.';
        if (placement === 'available') expect(request.lastUserText).toContain(expectedContext);
        else expect(request.lastUserText).not.toContain(expectedContext);
        expect(request.lastUserText).not.toContain(phase === 0 ? 'Synthetic destination file body.' : 'Synthetic source file body.');
        expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(prompts.slice(0, phase + 1));
        held.releaseText(`Synthetic reply ${phase}.`);
        expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId!, { afterIndex: cursor })).type)
          .toBe('agent-run-finished');
      } finally {
        held.allowAbort();
        held.releaseText('Synthetic cleanup.');
      }
    }
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
    await fixture.restartGarcon();
    expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(prompts);
  }, { authentication: 'account', bindAddress: '0.0.0.0',
    preloadModules: placement === 'unavailable' ? [placementFailurePreload] : [],
  });
}, 30_000);

test.each(['available', 'unavailable'] as const)('real Codex steering preserves authored input with %s mention placement', async (placement) => {
  const environment = await startScriptedCodexTestEnvironment();
  environment.model.scriptTurn([codexExecCommandCall('call_mention_context', 'pwd')]);
  const held = environment.model.scriptHeldTurn([codexAssistantMessage('Synthetic initial reply.')]);
  environment.model.scriptTurn([codexAssistantMessage('Synthetic steered reply.')]);
  try {
    await withIntegrationFixture('workspace-file-mentions-steer', async (fixture) => {
      await writeFile(join(fixture.dirs.project, 'notes.txt'), 'Synthetic steering file body.');
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'Synthetic initial input.', permissionMode: 'bypassPermissions',
      }));
      await held.requested;
      const request = { chatId, content: 'Inspect @notes.txt.',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() };
      expect(await fixture.client.steer(request)).toMatchObject({ status: 'accepted', turnId: first.turnId });
      expect(await fixture.client.steer(request)).toMatchObject({ status: 'duplicate', turnId: first.turnId });
      held.release();
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId, { afterIndex: cursor })).type)
        .toBe('agent-run-finished');
      const requests = environment.model.requests();
      expect(requests).toHaveLength(3);
      expect(requests[2]?.lastUserText).toContain(request.content);
      if (placement === 'available') expect(requests[2]?.lastUserText).toContain('Synthetic steering file body.');
      else expect(requests[2]?.lastUserText).not.toContain('Synthetic steering file body.');
      expect(userContents((await fixture.client.getMessages(chatId)).messages))
        .toEqual(['Synthetic initial input.', request.content]);
      environment.model.assertSettled();
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace,
      preloadModules: placement === 'unavailable' ? [placementFailurePreload] : [],
    });
  } finally {
    held.release();
    await environment.dispose();
  }
}, 60_000);
