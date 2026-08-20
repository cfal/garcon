import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
import { sacsScriptedDriverFactories } from './drivers.js';
import type { SacsDriverEnvironment } from './driver.js';

const SACS_TIMEOUT_MS = 120_000;

// Native-fidelity fork conformance is interface-shaped: the oracle is the
// public transcript and registry boundary, and the only provider-specific
// piece is the unsettle hook that removes a fork point from native history.
const EXPECTED_FORKING_DRIVER_IDS = [
  'claude',
  'codex',
  ...(process.platform === 'linux' ? ['opencode'] : []),
];

test('[TLV5-FORK.01-SACS-CAPABILITY-01] registers the native forking facet for every native-fork provider', () => {
  expect(sacsScriptedDriverFactories
    .filter((driver) => driver.forking !== null)
    .map((driver) => driver.id)
    .toSorted())
    .toEqual([...EXPECTED_FORKING_DRIVER_IDS].toSorted());
});

for (const driverFactory of sacsScriptedDriverFactories) {
  if (!driverFactory.forking) continue;
  const forking = driverFactory.forking;

  describe(`SACS native forking: ${driverFactory.label}`, () => {
    let driver: SacsDriverEnvironment | undefined;

    beforeAll(async () => {
      driver = await driverFactory.start();
    });

    afterAll(async () => {
      await driver?.dispose();
    });

    test('[TLV5-FORK.03-SACS-POINT-01] forks natively at a message point, seeds the prefix, and resumes independently', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);

      await withIntegrationFixture(`${activeDriver.id}-sacs-fork-point`, async (fixture) => {
        try {
          const source = await twoTurnChat(fixture, activeDriver, 'POINT');
          const transcript = await fixture.client.getMessages(source.chatId);
          const anchor = transcript.messages.find((entry) => (
            entry.message.type === 'assistant-message'
            && entry.message.content.includes(source.firstReply)
          ));
          if (!anchor) throw new Error('Source transcript is missing the first reply row.');

          const forkChatId = fixture.newChatId();
          await fixture.client.forkChat({
            sourceChatId: source.chatId,
            chatId: forkChatId,
            upToOrdinal: anchor.ordinal,
            transcriptViewId: transcript.transcriptViewId,
          });

          const forked = await fixture.client.getMessages(forkChatId);
          expect(userContents(forked.messages)).toEqual([source.firstPrompt]);
          expect(assistantContents(forked.messages)).toEqual([source.firstReply]);
          const forkedBinding = await readRegistryAgentSessionId(fixture, forkChatId);
          const sourceBinding = await readRegistryAgentSessionId(fixture, source.chatId);
          expect(forkedBinding).not.toBeNull();
          expect(forkedBinding).not.toBe(sourceBinding);

          const continuationPrompt = marker(activeDriver.id, 'POINT_CONTINUATION');
          const continuationReply = marker(activeDriver.id, 'POINT_CONTINUATION_REPLY');
          activeDriver.scriptAssistant(fixture, continuationReply);
          const continuation = await fixture.client.runChat(activeDriver.runRequest(fixture, {
            chatId: forkChatId,
            command: continuationPrompt,
          }));
          expect((await fixture.client.waitForTurnTerminal(forkChatId, continuation.turnId)).type)
            .toBe('agent-run-finished');
          expect(assistantContents((await fixture.client.getMessages(forkChatId)).messages))
            .toEqual([source.firstReply, continuationReply]);

          const sourceAfter = await fixture.client.getMessages(source.chatId);
          expect(userContents(sourceAfter.messages))
            .toEqual([source.firstPrompt, source.secondPrompt]);
          expect(assistantContents(sourceAfter.messages))
            .toEqual([source.firstReply, source.secondReply]);
          activeDriver.assertSettled(fixture);
        } finally {
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    test('[TLV5-FORK.01-SACS-NOTSETTLED-01] refuses an unsettled fork point until handoff consent', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);

      await withIntegrationFixture(`${activeDriver.id}-sacs-fork-refusal`, async (fixture) => {
        try {
          const source = await twoTurnChat(fixture, activeDriver, 'REFUSAL');
          const transcript = await fixture.client.getMessages(source.chatId);
          const anchor = [...transcript.messages].reverse().find((entry) => (
            entry.message.type === 'assistant-message'
            && entry.message.content.includes(source.secondReply)
          ));
          if (!anchor) throw new Error('Source transcript is missing the second reply row.');

          await forking.unsettle(fixture, source.chatId, source.secondReply);

          const forkChatId = fixture.newChatId();
          const refusal = await fixture.client.forkChat({
            sourceChatId: source.chatId,
            chatId: forkChatId,
            upToOrdinal: anchor.ordinal,
            transcriptViewId: transcript.transcriptViewId,
          }).then(() => null, (error: unknown) => error);
          expect(refusal).toBeInstanceOf(GarconApiError);
          expect(refusal).toMatchObject({
            status: 409,
            body: {
              errorCode: 'TRANSCRIPT_NOT_YET_PERSISTED',
              retryable: true,
            },
          });

          const consented = await fixture.client.forkChat({
            sourceChatId: source.chatId,
            chatId: forkChatId,
            upToOrdinal: anchor.ordinal,
            transcriptViewId: transcript.transcriptViewId,
            allowHandoffFork: true,
          });
          expect(consented.chat.id).toBe(forkChatId);

          const forked = await fixture.client.getMessages(forkChatId);
          expect(userContents(forked.messages))
            .toEqual([source.firstPrompt, source.secondPrompt]);
          expect(assistantContents(forked.messages))
            .toEqual([source.firstReply, source.secondReply]);
          expect(await readRegistryAgentSessionId(fixture, forkChatId)).toBeNull();
          activeDriver.assertSettled(fixture);
        } finally {
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);
  });
}

interface TwoTurnChat {
  readonly chatId: string;
  readonly firstPrompt: string;
  readonly firstReply: string;
  readonly secondPrompt: string;
  readonly secondReply: string;
}

async function twoTurnChat(
  fixture: IntegrationFixture,
  driver: SacsDriverEnvironment,
  label: string,
): Promise<TwoTurnChat> {
  const firstPrompt = marker(driver.id, `${label}_FIRST_PROMPT`);
  const firstReply = marker(driver.id, `${label}_FIRST_REPLY`);
  const secondPrompt = marker(driver.id, `${label}_SECOND_PROMPT`);
  const secondReply = marker(driver.id, `${label}_SECOND_REPLY`);
  driver.scriptAssistant(fixture, firstReply);
  driver.scriptAssistant(fixture, secondReply);
  const chatId = fixture.newChatId();
  const first = await fixture.client.startChat(driver.startRequest(fixture, {
    chatId,
    projectPath: fixture.dirs.project,
    command: firstPrompt,
  }));
  expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type)
    .toBe('agent-run-finished');
  const second = await fixture.client.runChat(driver.runRequest(fixture, {
    chatId,
    command: secondPrompt,
  }));
  expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type)
    .toBe('agent-run-finished');
  return { chatId, firstPrompt, firstReply, secondPrompt, secondReply };
}

async function readRegistryAgentSessionId(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<string | null> {
  const registryPath = join(fixture.dirs.workspace, 'chats.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
    sessions?: Record<string, { agentSessionId?: unknown }>;
  };
  const chat = registry.sessions?.[chatId];
  if (!chat) throw new Error(`SACS chat ${chatId} is missing from the registry.`);
  return typeof chat.agentSessionId === 'string' && chat.agentSessionId
    ? chat.agentSessionId
    : null;
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
