import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ChatMessage } from '../../../common/chat-types.js';
import { transcriptViewId, type LedgerRow } from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { sacsScriptedDriverFactories } from './drivers.js';
import type { SacsDriverEnvironment, SacsHeldTurn } from './driver.js';

const SACS_TIMEOUT_MS = 120_000;

for (const driverFactory of sacsScriptedDriverFactories) {
  describe(`SACS transcript lifecycle: ${driverFactory.label}`, () => {
    let driver: SacsDriverEnvironment | undefined;

    beforeAll(async () => {
      driver = await driverFactory.start();
    });

    afterAll(async () => {
      await driver?.dispose();
    });

    test('[TLV5-L04.01-SACS-SCRIPTED-01] commits an immediate input before provider dispatch observes it', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      const prompt = marker(activeDriver.id, 'IMMEDIATE_INPUT');
      const reply = marker(activeDriver.id, 'IMMEDIATE_REPLY');

      await withIntegrationFixture(`${activeDriver.id}-sacs-immediate-input`, async (fixture) => {
        const held = activeDriver.holdAssistant(fixture, reply);
        try {
          const catalogEntry = (await fixture.client.listAgentCatalog()).agents
            .find((entry) => entry.id === activeDriver.id);
          expect(catalogEntry?.supportsSteering).toBe(driverFactory.steering !== null);
          const chatId = fixture.newChatId();
          const requestCursor = activeDriver.markRequests(fixture);
          const turn = await fixture.client.startChat(activeDriver.startRequest(fixture, {
            chatId,
            projectPath: fixture.dirs.project,
            command: prompt,
          }));
          await held.requested;

          const beforeReply = await fixture.client.getMessages(chatId);
          expect(userContents(beforeReply.messages)).toEqual([prompt]);
          expect(assistantContents(beforeReply.messages)).toEqual([]);
          expectAddressedRows(beforeReply.transcriptViewId, beforeReply.messages);
          expect(activeDriver.userTextsSince(fixture, requestCursor).join('\n')).toContain(prompt);

          held.release();
          expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId)).type)
            .toBe('agent-run-finished');
          expect(assistantContents((await fixture.client.getMessages(chatId)).messages))
            .toContain(reply);
          activeDriver.assertSettled(fixture);
        } finally {
          held.release();
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    test('[TLV5-L04.04-SACS-SCRIPTED-01] never redispatches an identical committed submission', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      const prompt = marker(activeDriver.id, 'DUPLICATE_INPUT');
      const reply = marker(activeDriver.id, 'DUPLICATE_REPLY');

      await withIntegrationFixture(`${activeDriver.id}-sacs-duplicate-input`, async (fixture) => {
        const held = activeDriver.holdAssistant(fixture, reply);
        try {
          const chatId = fixture.newChatId();
          const requestCursor = activeDriver.markRequests(fixture);
          const request = activeDriver.startRequest(fixture, {
            chatId,
            projectPath: fixture.dirs.project,
            command: prompt,
          });
          const first = await fixture.client.startChat(request);
          await held.requested;

          expect(await fixture.client.startChat(request)).toMatchObject({
            status: 'duplicate',
            turnId: first.turnId,
          });
          expect(activeDriver.requestCountSince(fixture, requestCursor)).toBe(1);
          expect(activeDriver.userTextsSince(fixture, requestCursor).join('\n')).toContain(prompt);
          const whileHeld = await fixture.client.getMessages(chatId);
          expect(userContents(whileHeld.messages)).toEqual([prompt]);
          expectAddressedRows(whileHeld.transcriptViewId, whileHeld.messages);

          held.release();
          expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type)
            .toBe('agent-run-finished');
          const completed = await fixture.client.getMessages(chatId);
          expect(userContents(completed.messages)).toEqual([prompt]);
          expect(assistantContents(completed.messages)).toEqual([reply]);
          expectAddressedRows(completed.transcriptViewId, completed.messages);
          activeDriver.assertSettled(fixture);
        } finally {
          held.release();
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    if (driverFactory.steering) {
      test('[TLV5-L04.02-SACS-SCRIPTED-01] commits steering before the provider receives it', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);
        const prompt = marker(activeDriver.id, 'STEER_INITIAL');
        const steer = marker(activeDriver.id, 'STEER_GUIDANCE');
        const firstReply = marker(activeDriver.id, 'STEER_FIRST_REPLY');
        const steeredReply = marker(activeDriver.id, 'STEER_SECOND_REPLY');

        await withIntegrationFixture(`${activeDriver.id}-sacs-steer-order`, async (fixture) => {
          const held = activeDriver.holdAssistant(fixture, firstReply);
          activeDriver.scriptAssistant(fixture, steeredReply);
          try {
            const chatId = fixture.newChatId();
            const requestCursor = activeDriver.markRequests(fixture);
            const turn = await fixture.client.startChat(activeDriver.startRequest(fixture, {
              chatId,
              projectPath: fixture.dirs.project,
              command: prompt,
            }));
            await held.requested;

            expect(await fixture.client.steer({
              clientRequestId: crypto.randomUUID(),
              clientMessageId: crypto.randomUUID(),
              chatId,
              content: steer,
            })).toMatchObject({ status: 'accepted', turnId: turn.turnId });

            const beforeDelivery = await fixture.client.getMessages(chatId);
            expect(userContents(beforeDelivery.messages)).toEqual([prompt, steer]);
            expectAddressedRows(beforeDelivery.transcriptViewId, beforeDelivery.messages);

            held.release();
            expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId)).type)
              .toBe('agent-run-finished');
            expect(activeDriver.userTextsSince(fixture, requestCursor).join('\n')).toContain(steer);
            expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
              .toContain(steeredReply);
            activeDriver.assertSettled(fixture);
          } finally {
            held.release();
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);
    }

    test('[TLV5-L05.01-SACS-SCRIPTED-01] preserves exact observed order across consecutive operations', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      const firstPrompt = marker(activeDriver.id, 'ORDER_FIRST_INPUT');
      const firstReply = marker(activeDriver.id, 'ORDER_FIRST_REPLY');
      const secondPrompt = marker(activeDriver.id, 'ORDER_SECOND_INPUT');
      const secondReply = marker(activeDriver.id, 'ORDER_SECOND_REPLY');

      await withIntegrationFixture(`${activeDriver.id}-sacs-observed-order`, async (fixture) => {
        try {
          activeDriver.scriptAssistant(fixture, firstReply);
          activeDriver.scriptAssistant(fixture, secondReply);
          const chatId = fixture.newChatId();
          const first = await fixture.client.startChat(activeDriver.startRequest(fixture, {
            chatId,
            projectPath: fixture.dirs.project,
            command: firstPrompt,
          }));
          expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type)
            .toBe('agent-run-finished');
          const firstView = (await fixture.client.getMessages(chatId)).transcriptViewId;

          const second = await fixture.client.runChat(activeDriver.runRequest(fixture, {
            chatId,
            command: secondPrompt,
          }));
          expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type)
            .toBe('agent-run-finished');

          const transcript = await fixture.client.getMessages(chatId);
          expect(transcript.transcriptViewId).toBe(firstView);
          expect(conversationalContents(transcript.messages)).toEqual([
            firstPrompt,
            firstReply,
            secondPrompt,
            secondReply,
          ]);
          expectAddressedRows(transcript.transcriptViewId, transcript.messages);
          activeDriver.assertSettled(fixture);
        } finally {
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    if (driverFactory.nativeSessions) {
      test('[TLV5-L06.02-SACS-SCRIPTED-01] emits one session fact for start and none for resume', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);
        const firstPrompt = marker(activeDriver.id, 'SESSION_START');
        const secondPrompt = marker(activeDriver.id, 'SESSION_RESUME');

        await withIntegrationFixture(`${activeDriver.id}-sacs-session-facts`, async (fixture) => {
          try {
            activeDriver.scriptAssistant(fixture, marker(activeDriver.id, 'SESSION_FIRST_REPLY'));
            activeDriver.scriptAssistant(fixture, marker(activeDriver.id, 'SESSION_SECOND_REPLY'));
            const chatId = fixture.newChatId();
            const first = await fixture.client.startChat(activeDriver.startRequest(fixture, {
              chatId,
              projectPath: fixture.dirs.project,
              command: firstPrompt,
            }));
            expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type)
              .toBe('agent-run-finished');
            const firstTranscript = await fixture.client.getMessages(chatId);
            expect(readRows(fixture, chatId, firstTranscript.transcriptViewId)
              .filter((row) => row.kind === 'session')).toHaveLength(1);

            const second = await fixture.client.runChat(activeDriver.runRequest(fixture, {
              chatId,
              command: secondPrompt,
            }));
            expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type)
              .toBe('agent-run-finished');
            const secondTranscript = await fixture.client.getMessages(chatId);
            expect(secondTranscript.transcriptViewId).toBe(firstTranscript.transcriptViewId);
            expect(readRows(fixture, chatId, secondTranscript.transcriptViewId)
              .filter((row) => row.kind === 'session')).toHaveLength(1);
            activeDriver.assertSettled(fixture);
          } finally {
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);
    }

    test('[TLV5-L06.03-SACS-SCRIPTED-01] interrupts once and admits a clean successor operation', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      const interruptedPrompt = marker(activeDriver.id, 'INTERRUPTED_INPUT');
      const rejectedReply = marker(activeDriver.id, 'INTERRUPTED_REPLY');
      const recoveryPrompt = marker(activeDriver.id, 'RECOVERY_INPUT');
      const recoveryReply = marker(activeDriver.id, 'RECOVERY_REPLY');

      await withIntegrationFixture(`${activeDriver.id}-sacs-interrupt`, async (fixture) => {
        const held = activeDriver.holdInterruptibleAssistant(fixture, rejectedReply);
        let recoveryHeld: SacsHeldTurn | null = null;
        try {
          const chatId = fixture.newChatId();
          const active = await fixture.client.startChat(activeDriver.startRequest(fixture, {
            chatId,
            projectPath: fixture.dirs.project,
            command: interruptedPrompt,
          }));
          await held.requested;

          held.allowCancellation();
          const stopCursor = fixture.client.markEvents();
          expect(await fixture.client.stopChat({
            chatId,
            clientRequestId: crypto.randomUUID(),
          })).toMatchObject({ outcome: 'interrupt-requested' });
          await fixture.client.waitForProcessing(chatId, false, { afterIndex: stopCursor });
          await fixture.client.waitForSessionStopped(chatId, { afterIndex: stopCursor });

          const interruptedTranscript = await fixture.client.getMessages(chatId);
          expect(userContents(interruptedTranscript.messages)).toEqual([interruptedPrompt]);
          expect(assistantContents(interruptedTranscript.messages)).toEqual([]);
          expect(readRows(fixture, chatId, interruptedTranscript.transcriptViewId)
            .filter((row) => row.kind === 'run-ended')).toEqual([
              expect.objectContaining({
                kind: 'run-ended',
                outcome: 'interrupted',
                origin: 'core',
              }),
            ]);

          recoveryHeld = activeDriver.holdAssistant(fixture, recoveryReply);
          held.release();
          const recovery = await fixture.client.runChat(activeDriver.runRequest(fixture, {
            chatId,
            command: recoveryPrompt,
          }));
          await recoveryHeld.requested;
          expect((await fixture.client.getChatSnapshot(chatId, 0)).processingPhase).toBe('running');

          recoveryHeld.release();
          expect((await fixture.client.waitForTurnTerminal(chatId, recovery.turnId)).type)
            .toBe('agent-run-finished');
          const recovered = await fixture.client.getMessages(chatId);
          expect(userContents(recovered.messages)).toEqual([interruptedPrompt, recoveryPrompt]);
          expect(assistantContents(recovered.messages).filter((content) => content === recoveryReply))
            .toHaveLength(1);
          const lateInterruptedRows = recovered.messages.filter((entry) =>
            entry.message.type === 'assistant-message'
            && entry.message.content === rejectedReply);
          expect(lateInterruptedRows.length).toBeLessThanOrEqual(1);
          expectAddressedRows(recovered.transcriptViewId, recovered.messages);

          const recoveryInputRow = recovered.messages.find((entry) =>
            entry.message.type === 'user-message'
            && entry.message.content === recoveryPrompt);
          const recoveryReplyRow = recovered.messages.find((entry) =>
            entry.message.type === 'assistant-message'
            && entry.message.content === recoveryReply);
          expect(recoveryInputRow).toBeDefined();
          expect(recoveryReplyRow).toBeDefined();
          expect(recoveryReplyRow!.ordinal).toBeGreaterThan(recoveryInputRow!.ordinal);
          if (lateInterruptedRows[0]) {
            expect(lateInterruptedRows[0].ordinal).toBeGreaterThan(recoveryInputRow!.ordinal);
          }
          activeDriver.assertSettled(fixture);
          expect(active.turnId).not.toBe(recovery.turnId);
        } finally {
          held.release();
          recoveryHeld?.release();
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    test('[TLV5-L06.06-SACS-SCRIPTED-01] synthesizes no terminal or active run after a process crash', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      const prompt = marker(activeDriver.id, 'CRASH_INPUT');
      const reply = marker(activeDriver.id, 'CRASH_UNACCEPTED_REPLY');

      await withIntegrationFixture(`${activeDriver.id}-sacs-crash-run`, async (fixture) => {
        const held = activeDriver.holdAssistant(fixture, reply);
        try {
          const chatId = fixture.newChatId();
          await fixture.client.startChat(activeDriver.startRequest(fixture, {
            chatId,
            projectPath: fixture.dirs.project,
            command: prompt,
          }));
          await held.requested;
          const beforeCrash = await fixture.client.getMessages(chatId);
          const rowsBeforeCrash = readRows(fixture, chatId, beforeCrash.transcriptViewId);
          expect(rowsBeforeCrash.some((row) => row.kind === 'run-ended')).toBe(false);

          held.allowCancellation();
          await fixture.crashAndRestartGarcon();
          const afterCrash = await fixture.client.getMessages(chatId);
          expect(afterCrash.transcriptViewId).toBe(beforeCrash.transcriptViewId);
          expect(userContents(afterCrash.messages)).toEqual([prompt]);
          expect(assistantContents(afterCrash.messages)).toEqual([]);
          expect(readRows(fixture, chatId, afterCrash.transcriptViewId)
            .some((row) => row.kind === 'run-ended')).toBe(false);
          expect((await fixture.client.getChatSnapshot(chatId, 1)).processingPhase).toBeNull();
        } finally {
          held.release();
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);
  });
}

function requireDriver(
  driver: SacsDriverEnvironment | undefined,
  label: string,
): SacsDriverEnvironment {
  if (!driver) throw new Error(`${label} SACS driver was not initialized.`);
  return driver;
}

function marker(agentId: string, label: string): string {
  return `SACS_${agentId.toUpperCase()}_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function conversationalContents(messages: readonly { message: ChatMessage }[]): string[] {
  return messages.flatMap(({ message }) => {
    if (message.type === 'user-message' || message.type === 'assistant-message') {
      return [message.content];
    }
    return [];
  });
}

function expectAddressedRows(
  transcriptViewId: string,
  messages: readonly { ordinal: number; message: ChatMessage }[],
): void {
  expect(messages.every((entry) => Number.isSafeInteger(entry.ordinal) && entry.ordinal > 0))
    .toBe(true);
  expect(new Set(messages.map((entry) => `${transcriptViewId}:${entry.ordinal}`)).size)
    .toBe(messages.length);
  expect(messages.map((entry) => entry.ordinal)).toEqual(
    messages.map((entry) => entry.ordinal).toSorted((left, right) => left - right),
  );
}

function readRows(
  fixture: IntegrationFixture,
  chatId: string,
  viewId: string,
): readonly LedgerRow[] {
  const store = new TranscriptLedgerStore(join(fixture.dirs.workspace, 'transcript-ledgers'));
  try {
    return store.page(chatId, transcriptViewId(viewId), 500).rows;
  } finally {
    store.close();
  }
}
