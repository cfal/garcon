import { expect, test } from 'bun:test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import { scriptedPiRunRequest, scriptedPiStartRequest, startScriptedPiTestEnvironment } from '../../support/scripted-pi.js';
import { userContents } from '../../support/chat-assertions.js';

for (const disposition of ['handled', 'independent', 'transformed'] as const) {
  test(`uses the real CLI ${disposition} steering disposition without replaying the input`, async () => {
    let handleInput = "return { action: 'handled' };";
    if (disposition === 'transformed') handleInput = "return { action: 'transform', text: 'steer B' };";
    if (disposition === 'independent') {
      handleInput = "pi.sendUserMessage('steer B', { deliverAs: 'followUp' }); return { action: 'handled' };";
    }
    const environment = startScriptedPiTestEnvironment({ extensionSource: `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function (pi) {
  pi.on('input', (event, ctx) => {
    if (event.source !== 'rpc') return;
    appendFileSync(join(ctx.cwd, 'pi-inputs.jsonl'), JSON.stringify({ text: event.text, pid: process.pid }) + '\\n');
    if (event.text !== 'steer A') return;
    ${handleInput}
  });
}

` });
    try {
      const held = environment.model.scriptHeldTurn([chatCompletionsText('first reply')]);
      if (disposition !== 'handled') environment.model.scriptTurn([chatCompletionsText('steered reply')]);
      await withIntegrationFixture(`pi-disposition-${disposition}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const started = await fixture.client.startChat(scriptedPiStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'first prompt',
        }));
        await held.requested;
        expect(await fixture.client.steer({
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), chatId, content: 'steer A',
        })).toMatchObject({ status: 'accepted', turnId: started.turnId });
        held.release();
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, started.turnId!, {
          afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        const requests = environment.model.requests();
        expect(requests).toHaveLength(disposition === 'handled' ? 1 : 2);
        expect(requests.flatMap((request) => request.userTexts)).not.toContain('steer A');
        if (disposition !== 'handled') expect(requests[1].lastUserText).toBe('steer B');
        expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(['first prompt', 'steer A']);

        environment.model.scriptTurn([chatCompletionsText('next reply')]);
        const nextCursor = fixture.client.markEvents();
        const next = await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'next prompt' }));
        await waitForVisibleResponse({ fixture, chatId, turnId: next.turnId, marker: 'next reply', afterIndex: nextCursor });
        const inputs = await readPiInputs(fixture.dirs.project);
        expect(inputs.map((input) => input.text)).toEqual(['first prompt', 'steer A', 'next prompt']);
        expect(inputs[0].pid).toBe(inputs[2].pid);
        environment.model.assertSettled();
      }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
    } finally {
      environment.dispose();
    }
  }, 120_000);
}

for (const disposition of ['handled', 'queued'] as const) {
  test(`settles a real ${disposition} steer acknowledgement after its target run ends`, async () => {
    const environment = startScriptedPiTestEnvironment({ extensionSource: `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function (pi) {
  let release;
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'rpc') return;
    appendFileSync(join(ctx.cwd, 'pi-inputs.jsonl'), JSON.stringify({ pid: process.pid, text: event.text }) + '\\n');
    if (event.text !== 'late steer') return;
    const gate = new Promise(resolve => { release = resolve; });
    writeFileSync(join(ctx.cwd, 'input-waiting'), 'ready');
    await gate;
    return { action: '${disposition === 'handled' ? 'handled' : 'continue'}' };
  });
  pi.on('agent_settled', () => { if (release) setTimeout(release, 0); });
}
` });
    try {
      const held = environment.model.scriptHeldTurn([chatCompletionsText('first reply')]);
      await withIntegrationFixture(`pi-late-${disposition}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const started = await fixture.client.startChat(scriptedPiStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'first prompt',
        }));
        await held.requested;
        const steering = fixture.client.steer({
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), chatId, content: 'late steer',
        }).then((response) => response, (error: unknown) => error);
        await waitForFile(join(fixture.dirs.project, 'input-waiting'));
        held.release();
        const outcome = await steering;
        if (disposition === 'handled') expect(outcome).toMatchObject({ status: 'accepted' });
        else expect(outcome).toMatchObject({ body: { errorCode: 'STEER_OUTCOME_UNKNOWN', retryable: false } });
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, started.turnId!, {
          afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);
        environment.model.scriptTurn([chatCompletionsText('next reply')]);
        const nextCursor = fixture.client.markEvents();
        const next = await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'next prompt' }));
        await waitForVisibleResponse({ fixture, chatId, turnId: next.turnId, marker: 'next reply', afterIndex: nextCursor });
        const inputs = await readPiInputs(fixture.dirs.project);
        expect(inputs.map((input) => input.text)).toEqual(['first prompt', 'late steer', 'next prompt']);
        expect(inputs[0].pid === inputs[2].pid).toBe(disposition === 'handled');
        expect(environment.model.requests().flatMap((request) => request.userTexts)).not.toContain('late steer');
        environment.model.assertSettled();
      }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
    } finally {
      environment.dispose();
    }
  }, 120_000);
}

for (const independentSettled of [false, true]) {
  test(`retires post-settlement work before the next turn (independent settled=${independentSettled})`, async () => {
    const environment = startScriptedPiTestEnvironment({ extensionSource: `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function (pi) {
  let release;
  let settled = 0;
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'rpc') return;
    appendFileSync(join(ctx.cwd, 'pi-inputs.jsonl'), JSON.stringify({ pid: process.pid, text: event.text }) + '\\n');
    if (event.text !== 'late handled steer') return;
    const gate = new Promise(resolve => { release = resolve; });
    writeFileSync(join(ctx.cwd, 'input-waiting'), 'ready');
    await gate;
    pi.sendUserMessage('independent prompt');
    while (!existsSync(join(ctx.cwd, 'release-input'))) await new Promise(resolve => setTimeout(resolve, 10));
    return { action: 'handled' };
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (++settled === 2) writeFileSync(join(ctx.cwd, 'independent-settled'), 'ready');
    if (release) { setTimeout(release, 0); release = undefined; }
  });
}
` });
    try {
      const original = environment.model.scriptHeldTurn([chatCompletionsText('original reply')]);
      const independent = environment.model.scriptHeldTurn([chatCompletionsText('orphan reply')]);
      await withIntegrationFixture('pi-reserved-settle', async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const started = await fixture.client.startChat(scriptedPiStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'first prompt',
        }));
        await original.requested;
        const steering = fixture.client.steer({
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), chatId, content: 'late handled steer',
        });
        await waitForFile(join(fixture.dirs.project, 'input-waiting'));
        original.release();
        expect((await independent.requested).lastUserText).toBe('independent prompt');
        if (independentSettled) {
          independent.release();
          await waitForFile(join(fixture.dirs.project, 'independent-settled'));
        }
        await writeFile(join(fixture.dirs.project, 'release-input'), 'ready');
        expect(await steering).toMatchObject({ status: 'accepted' });
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, started.turnId!, {
          afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);

        const firstInput = JSON.parse((await readFile(join(fixture.dirs.project, 'pi-inputs.jsonl'), 'utf8')).split('\n')[0]) as { pid: number };
        // A successor also fences busy processes, so retirement must precede its admission.
        await waitForProcessExit(firstInput.pid);
        expect(JSON.stringify((await fixture.client.getMessages(chatId)).messages)).not.toContain('orphan reply');

        environment.model.scriptTurn([chatCompletionsText('next reply')]);
        const nextCursor = fixture.client.markEvents();
        const next = await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'next prompt' }));
        await waitForVisibleResponse({ fixture, chatId, turnId: next.turnId, marker: 'next reply', afterIndex: nextCursor });
        independent.release();
        const inputs = await readPiInputs(fixture.dirs.project);
        expect(inputs.map((input) => input.text)).toEqual(['first prompt', 'late handled steer', 'next prompt']);
        expect(inputs[0].pid).not.toBe(inputs[2].pid);
        expect(environment.model.requests()).toHaveLength(3);
        expect(JSON.stringify((await fixture.client.getMessages(chatId)).messages)).not.toContain('orphan reply');
        environment.model.assertSettled();
      }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
    } finally {
      environment.dispose();
    }
  }, 120_000);
}

async function readPiInputs(projectPath: string): Promise<Array<{ pid: number; text: string }>> {
  const contents = await readFile(join(projectPath, 'pi-inputs.jsonl'), 'utf8');
  return contents.trim().split('\n').map((line) => JSON.parse(line));
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Settled turn left Pi process ${pid} running`);
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
  throw new Error(`Pi never created ${path}`);
}
