import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'bun:test';
import { assertBombadilNotInterrupted, runBombadil } from '../bombadil/run.js';
import { terminalOutcomesMatch, type ExpectedTurn } from '../bombadil/settlement.js';
import type { AcceptedTurn, BrowserConfig, Campaign } from '../bombadil/browser.js';
import { assistantContents, userContents, userMessages } from './chat-assertions.js';
import { withIntegrationFixture } from './integration-fixture.js';
import { requireCurrentWebBuild } from './web-build-gate.js';

const ROOT = resolve(import.meta.dir, '../..');

export async function runBombadilCampaign(campaign: Campaign, instrument = false): Promise<void> {
  assertBombadilNotInterrupted();
  const signal = AbortSignal.timeout(120_000);
  await requireCurrentWebBuild();
  const artifacts = await mkdtemp(await mkdir(join(ROOT, 'integration-tests/artifacts/bombadil'), { recursive: true })
    .then(() => join(ROOT, `integration-tests/artifacts/bombadil/${campaign}-`)));
  // Private source is outside retained artifacts, including when fixture retention is enabled.
  const privateDirectory = await mkdtemp(join(tmpdir(), 'garcon-bombadil-'));
  let fixtureDiagnostics: (() => unknown) | undefined;
  try {
    await withIntegrationFixture(`bombadil-${campaign}`, async fixture => {
      fixtureDiagnostics = () => fixture.diagnostics();
      const { client, executionDirs, directAgents, fakeProviders } = fixture;
      const chatA = '1700000000000001';
      const chatB = '1700000000000002';
      const expectedTurns: ExpectedTurn[] = [];
      for (const [chatId, content] of [[chatA, 'bombadilalpha'], [chatB, 'bombadilbravo']]) {
        for (let index = 0; index < 8; index++) {
          const input = { chatId, content: `${content}${index}`, projectPath: executionDirs.project, agent: directAgents.openAi };
          const started = index === 0 ? await client.startDirectChat(input) : await client.runDirectChat(input);
          if (!started.turnId) throw new Error('Seed command is missing its turn identity');
          expectedTurns.push({ chatId, turnId: started.turnId, outcome: 'finished' });
          expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished', outcome: 'finished', exitCode: 0 });
        }
      }
      const beforeA = await client.getMessages(chatA, { limit: 200 });
      const beforeB = await client.getMessages(chatB, { limit: 200 });
      const held = campaign === 'queue' ? fakeProviders.openAi.holdNext({ lastUserText: 'bombadilheld' }) : null;
      if (held) {
        held.allowAbort();
        const started = await client.runDirectChat({ chatId: chatA, content: 'bombadilheld', agent: directAgents.openAi });
        if (!started.turnId) throw new Error('Held command is missing its turn identity');
        expectedTurns.push({ chatId: chatA, turnId: started.turnId, outcome: 'interrupted' });
        await held.received;
      }
      try {
        const config: BrowserConfig = {
          origin: fixture.garcon.baseUrl, token: fixture.garcon.authToken!, runId: crypto.randomUUID(), chatA, chatB, campaign,
        };
        const specification = join(privateDirectory, 'entry.ts');
        await writeFile(specification, `import { createSpecification } from ${JSON.stringify(join(ROOT, 'integration-tests/bombadil/specification.ts'))};
export { noUncaughtExceptions, noUnhandledPromiseRejections, noConsoleErrors } from '@antithesishq/bombadil/browser/defaults/properties';
const specification = createSpecification(${JSON.stringify(config)});
export const workflow = specification.actions;
export const invariants = specification.properties;
`, { mode: 0o600 });
        await writeFile(join(artifacts, 'fixture.json'), JSON.stringify({
          campaign, backend: fixture.diagnostics().executionBackend, executorId: client.executorId,
          recipe: { chatA, chatB, prompts: ['bombadilalpha', 'bombadilbravo'], turnsPerChat: 8 },
          webBuild: JSON.parse(await readFile(join(ROOT, 'web/build/.garcon-build-input-hash'), 'utf8')),
        }, null, 2));
        const summary = await runBombadil({ origin: `${config.origin}/chat/${chatA}`, specification, privateDirectory, artifacts,
          seconds: campaign === 'queue' ? 60 : 35, instrument, signal, redact: [config.token], reproduce: process.env.BOMBADIL_REPRODUCE,
          sources: ['browser.ts', 'properties.ts', 'specification.ts'].map(name => join(ROOT, 'integration-tests/bombadil', name)) });
        console.log(`Bombadil ${campaign}: ${summary.states} states, ${summary.actions} actions, largest capture gap ${Math.round(summary.maxCaptureGapMs)}ms`);
        if (held) await held.expectAbort();
        const afterA = await client.getMessages(chatA, { limit: 200 });
        const afterB = await client.getMessages(chatB, { limit: 200 });
        expect(afterB).toEqual(beforeB);
        expect(afterA.hasMore).toBe(false);
        expect(afterA.transcriptViewId).toBe(beforeA.transcriptViewId);
        expect(afterA.messages.slice(0, beforeA.messages.length)).toEqual(beforeA.messages);
        // The canonical presentation fold omits lifecycle rows, so addresses need not be dense.
        const ordinals = afterA.messages.map(row => row.ordinal);
        expect(ordinals).toEqual([...new Set(ordinals)].sort((left, right) => left - right));
        if (campaign === 'navigation') expect(afterA).toEqual(beforeA);
        const newPrompts = campaign === 'navigation' ? [] : campaign === 'submission' ? ['bombadilclick', 'bombadilenter']
          : ['bombadilheld', 'bombadilafterstop'];
        const prompts = [...userContents(beforeA.messages), ...newPrompts];
        expect(userContents(afterA.messages)).toEqual(prompts);
        // Direct providers coalesce adjacent user messages after an interrupted turn.
        const providerPrompts = prompts.map(prompt => prompt === 'bombadilafterstop' ? 'bombadilheld\n\nbombadilafterstop' : prompt);
        expect(assistantContents(afterA.messages)).toEqual(providerPrompts.filter(prompt => prompt !== 'bombadilheld').map(prompt => `echo:${prompt}`));
        expect(fakeProviders.openAi.requests().map(request => request.lastUserText).sort()).toEqual([...providerPrompts, ...userContents(beforeB.messages)].sort());
        expect(fakeProviders.anthropic.requests()).toHaveLength(0);
        expect(fakeProviders.openAiResponses.diagnosticRequests()).toHaveLength(0);
        const acceptedTurns = summary.observations.at(-1)?.acceptedTurns as AcceptedTurn[];
        const submitted = userMessages(afterA.messages.slice(beforeA.messages.length)).filter(message => message.content !== 'bombadilheld');
        const committedInputs = submitted.map(message => {
          const clientMessageId = message.metadata?.clientMessageId;
          if (!clientMessageId) throw new Error('Committed input is missing its submission identity');
          return { chatId: chatA, clientMessageId };
        });
        expect(acceptedTurns.map(({ chatId, clientMessageId }) => ({ chatId, clientMessageId }))).toEqual(committedInputs);
        expectedTurns.push(...acceptedTurns.map(turn => ({ ...turn, outcome: 'finished' as const })));
        for (const { chatId, turnId, outcome } of expectedTurns) {
          expect(await client.waitForTurnTerminal(chatId, turnId)).toMatchObject({ type: 'agent-run-finished', outcome, exitCode: 0 });
        }
        for (const chatId of [chatA, chatB]) {
          const snapshot = await client.getChatSnapshot(chatId);
          expect(snapshot.chat.executorId ?? 'local').toBe(client.executorId);
          expect(snapshot.chat.projectPath).toBe(executionDirs.project);
          expect(snapshot.processingPhase).toBeNull();
          const { queue } = await client.getExecutionControl(chatId);
          expect(queue.entries).toEqual([]);
          expect(queue.pause).toBeNull();
        }
        expect(terminalOutcomesMatch(expectedTurns, client.events())).toBe(true);
        await writeFile(join(artifacts, 'assertions.json'), JSON.stringify({ passed: true, prompts, view: afterA.transcriptViewId }));
      } finally { held?.releaseEcho(); }
    }, { projectRoots: 'separate' });
    await rm(artifacts, { recursive: true, force: true });
  } catch (error) {
    await writeFile(join(artifacts, 'fixture-diagnostics.json'), JSON.stringify({
      failure: error instanceof Error ? error.message.split('\nIntegration diagnostics:')[0] : String(error),
      fixture: fixtureDiagnostics?.(),
    }, null, 2));
    throw error;
  } finally { await rm(privateDirectory, { recursive: true, force: true }); }
}
