import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import { piNativeSession, scriptedPiRunRequest, scriptedPiStartRequest, startScriptedPiTestEnvironment } from '../../support/scripted-pi.js';

for (const mode of ['new', 'established', 'adopt'] as const) {
  test(`completes a real handled prompt in a ${mode} session without losing the next turn`, async () => {
    const environment = startScriptedPiTestEnvironment({ extensionSource: `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function (pi) {
  let started;
  pi.on('turn_start', () => started?.());
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'rpc') return;
    appendFileSync(join(ctx.cwd, 'pi-inputs.jsonl'), JSON.stringify({ pid: process.pid, text: event.text }) + '\\n');
    if (event.text !== 'handled prompt') return;
    if (${mode === 'adopt'}) {
      const running = new Promise(resolve => { started = resolve; });
      pi.sendUserMessage('independent prompt');
      await running;
    }
    return { action: 'handled' };
  });
}
` });
    try {
      await withIntegrationFixture(`pi-handled-prompt-${mode}`, async (fixture) => {
        const chatId = fixture.newChatId();
        if (mode === 'established') {
          environment.model.scriptTurn([chatCompletionsText('seed reply')]);
          const cursor = fixture.client.markEvents();
          const seed = await fixture.client.startChat(scriptedPiStartRequest({
            chatId, projectPath: fixture.dirs.project, command: 'seed prompt',
          }));
          await waitForVisibleResponse({ fixture, chatId, turnId: seed.turnId, marker: 'seed reply', afterIndex: cursor });
        }
        const held = mode === 'adopt' ? environment.model.scriptHeldTurn([chatCompletionsText('independent reply')]) : null;
        const cursor = fixture.client.markEvents();
        const turn = mode === 'established'
          ? await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'handled prompt' }))
          : await fixture.client.startChat(scriptedPiStartRequest({ chatId, projectPath: fixture.dirs.project, command: 'handled prompt' }));
        if (held) {
          await held.requested;
          expect(fixture.client.eventsSince(cursor).some((event) => event.type === 'agent-run-finished' && event.chatId === chatId)).toBe(false);
          held.release();
        }
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, turn.turnId!, {
          afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        if (mode === 'new') {
          const native = await piNativeSession(fixture, chatId);
          await expect(readFile(native.path)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        environment.model.scriptTurn([chatCompletionsText('next reply')]);
        const nextCursor = fixture.client.markEvents();
        const next = await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'next prompt' }));
        await waitForVisibleResponse({ fixture, chatId, turnId: next.turnId, marker: 'next reply', afterIndex: nextCursor });
        const inputs = (await readFile(join(fixture.dirs.project, 'pi-inputs.jsonl'), 'utf8')).trim()
          .split('\n').map((line) => JSON.parse(line) as { pid: number; text: string });
        expect(new Set(inputs.map((input) => input.pid)).size).toBe(1);
        expect(inputs.map((input) => input.text)).toEqual([
          ...(mode === 'established' ? ['seed prompt'] : []), 'handled prompt', 'next prompt',
        ]);
        expect(environment.model.requests().flatMap((request) => request.userTexts)).not.toContain('handled prompt');
        expect(environment.model.requests()).toHaveLength(mode === 'new' ? 1 : 2);
        environment.model.assertSettled();
      }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
    } finally {
      environment.dispose();
    }
  }, 120_000);
}
