import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import { piNativeSession, scriptedPiRunRequest, scriptedPiStartRequest, startScriptedPiTestEnvironment } from '../../support/scripted-pi.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('finishes a handled extension command before shutdown and respawns for the next turn', async () => {
  const environment = startScriptedPiTestEnvironment({ extensionSource: `
import { access, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    await appendFile(join(ctx.cwd, 'pi-processes.jsonl'), process.pid + '\\n');
  });
  pi.registerCommand('finish-session', {
    async handler(_args, ctx) {
      ctx.shutdown();
      await writeFile(join(ctx.cwd, 'pi-shutdown-requested'), 'ready');
      while (true) {
        try { await access(join(ctx.cwd, 'pi-shutdown-release')); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
  });
}
` });
  try {
    await withIntegrationFixture('pi-handled-shutdown', async (fixture) => {
      const chatId = fixture.newChatId();
      environment.model.scriptTurn([chatCompletionsText('seed reply')]);
      const seedCursor = fixture.client.markEvents();
      const seed = await fixture.client.startChat(scriptedPiStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'seed prompt',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: seed.turnId, marker: 'seed reply', afterIndex: seedCursor });

      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: '/finish-session' }));
      const requested = join(fixture.dirs.project, 'pi-shutdown-requested');
      const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
      while (!(await Bun.file(requested).exists())) {
        if (Date.now() >= deadline) throw new Error('Pi did not request shutdown');
        await Bun.sleep(20);
      }
      const pid = Number((await readFile(join(fixture.dirs.project, 'pi-processes.jsonl'), 'utf8')).trim());
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(fixture.client.eventsSince(cursor)).not.toContainEqual(expect.objectContaining({
        type: 'agent-run-finished', chatId, turnId: turn.turnId,
      }));
      await writeFile(join(fixture.dirs.project, 'pi-shutdown-release'), 'released');
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const exitDeadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
      while (true) {
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
          throw error;
        }
        if (Date.now() >= exitDeadline) throw new Error('Pi did not exit after the handled command');
        await Bun.sleep(20);
      }

      environment.model.scriptTurn([chatCompletionsText('next reply')]);
      const nextCursor = fixture.client.markEvents();
      const next = await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'next prompt' }));
      await waitForVisibleResponse({ fixture, chatId, turnId: next.turnId, marker: 'next reply', afterIndex: nextCursor });
      const pids = (await readFile(join(fixture.dirs.project, 'pi-processes.jsonl'), 'utf8')).trim().split('\n');
      expect(pids).toHaveLength(2);
      expect(new Set(pids).size).toBe(2);
      expect(environment.model.requests()).toHaveLength(2);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    environment.dispose();
  }
}, 120_000);

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
          expect(await rejectionOf(readFile(native.path))).toMatchObject({ code: 'ENOENT' });
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
