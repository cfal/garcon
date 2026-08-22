import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage } from '../../../common/chat-types.js';
import {
  transcriptViewId,
  type LedgerRow,
  type LedgerSessionRow,
} from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import {
  GarconApiError,
  GarconWsRequestError,
} from '../../support/garcon-client.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  sacsScriptedDriverFactories,
} from './drivers.js';
import type {
  SacsDriverEnvironment,
  SacsDirectoryScopedHistoryFacet,
  SacsLegacyHistoryImportFacet,
  SacsLegacyTranscriptRow,
  SacsPreparedHistorySource,
} from './driver.js';

const SACS_TIMEOUT_MS = 120_000;
const SOURCE_TIMESTAMP = '2026-08-16T00:00:00.000Z';

const DIRECT_DRIVER_IDS = [
  'direct-openai-responses-compatible',
  'direct-openai-compatible',
  'direct-anthropic-compatible',
] as const;
const EXPECTED_DIRECTORY_SCOPED_DRIVER_IDS = process.platform === 'linux'
  ? ['opencode']
  : [];

test('[TLV5-ADOPT.07-SACS-CAPABILITY-01] disables Direct legacy migration and retains native provider capabilities', () => {
  const directDrivers = sacsScriptedDriverFactories.filter((driver) => (
    DIRECT_DRIVER_IDS.includes(driver.id as typeof DIRECT_DRIVER_IDS[number])
  ));
  expect(directDrivers.map((driver) => [
    driver.id,
    driver.legacyHistoryImport,
    driver.nativeHistoryImport?.kind,
    driver.nativeSessions?.kind,
  ])).toEqual(DIRECT_DRIVER_IDS.map((id) => [
    id,
    null,
    'native-history-import',
    'native-sessions',
  ]));
  expect(sacsScriptedDriverFactories
    .filter((driver) => !DIRECT_DRIVER_IDS.includes(
      driver.id as typeof DIRECT_DRIVER_IDS[number],
    ))
    .every((driver) => driver.legacyHistoryImport !== null))
    .toBe(true);
  expect(sacsScriptedDriverFactories
    .filter((driver) => Boolean(driver.legacyHistoryImport?.directoryScoped))
    .map((driver) => driver.id))
    .toEqual(EXPECTED_DIRECTORY_SCOPED_DRIVER_IDS);
});

test('[TLV5-ADOPT.08-SACS-CAPABILITY-01] registers native import independently from legacy and session codecs', () => {
  expect(sacsScriptedDriverFactories.map((driver) => [
    driver.id,
    driver.nativeHistoryImport !== null,
  ])).toEqual([
    ['claude', true],
    ['codex', true],
    ['direct-openai-responses-compatible', true],
    ['direct-openai-compatible', true],
    ['direct-anthropic-compatible', true],
    ...(process.platform === 'linux' ? [['opencode', true]] : []),
    ['pi', true],
  ]);
});

for (const driverFactory of sacsScriptedDriverFactories) {
  if (!driverFactory.legacyHistoryImport) continue;
  describe(`SACS legacy history adoption: ${driverFactory.label}`, () => {
    let driver: SacsDriverEnvironment | undefined;

    beforeAll(async () => {
      driver = await driverFactory.start();
    });

    afterAll(async () => {
      await driver?.dispose();
    });

    test('[TLV5-ADOPT.07-SACS-IMPORT-01] adopts the exact supported legacy transcript once', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      const legacy = requireLegacyFacet(driverFactory.legacyHistoryImport, driverFactory.label);

      await withIntegrationFixture(`${activeDriver.id}-sacs-legacy-import`, async (fixture) => {
        try {
          const planted = await completedChat(fixture, activeDriver, 'IMPORT');
          await legacy.prepare(fixture, planted.chatId, planted.rows);

          await restartWithPreV5Chat(fixture, planted.chatId);

          const adopted = await fixture.client.getMessages(planted.chatId);
          expect(conversationalContents(adopted.messages)).toEqual(planted.contents);
          expectAddressedRows(adopted.transcriptViewId, adopted.messages);
          const rows = readRows(fixture, planted.chatId, adopted.transcriptViewId);
          expect(rows.filter((row) => row.kind === 'session')).toHaveLength(1);
          expect(rows.filter((row) => row.kind === 'user-input' || row.kind === 'provider-row'))
            .toHaveLength(planted.contents.length);
          activeDriver.assertSettled(fixture);
        } finally {
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    // Directory-scoped providers treat a recorded session the provider cannot
    // return as loss rather than absence; their absence and loss cases live in
    // the directory-scoped block below.
    if (!driverFactory.legacyHistoryImport?.directoryScoped) {
      test('[TLV5-ADOPT.01-SACS-ABSENCE-01] adopts a valid empty view when the supported legacy source is absent', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);
        const legacy = requireLegacyFacet(driverFactory.legacyHistoryImport, driverFactory.label);

        await withIntegrationFixture(`${activeDriver.id}-sacs-legacy-absence`, async (fixture) => {
          try {
            const planted = await completedChat(fixture, activeDriver, 'ABSENT');
            const source = await legacy.prepare(fixture, planted.chatId, planted.rows);
            const before = await fixture.client.getMessages(planted.chatId);
            const originalSessionDetail = requireSingleSessionDetail(
              readRows(fixture, planted.chatId, before.transcriptViewId),
            );
            const originalRegistryBinding = await readRegistrySessionBinding(
              fixture,
              planted.chatId,
            );
            expect(originalRegistryBinding).toEqual(originalSessionDetail);

            await restartWithPreV5Chat(fixture, planted.chatId, () => source.remove());

            const adopted = await fixture.client.getMessages(planted.chatId);
            expect(adopted.messages).toEqual([]);
            expect(readCurrentView(fixture, planted.chatId)).toMatchObject({
              viewId: transcriptViewId(adopted.transcriptViewId),
            });
            const adoptedRows = readRows(fixture, planted.chatId, adopted.transcriptViewId);
            expect(adoptedRows).toHaveLength(1);
            expect(requireSingleSessionDetail(adoptedRows)).toEqual(originalSessionDetail);
            expect(await readRegistrySessionBinding(fixture, planted.chatId))
              .toEqual(originalRegistryBinding);
            activeDriver.assertSettled(fixture);
          } finally {
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);
    }

    test('[TLV5-ADOPT.02-SERVER-FAIL-CLOSED-01] exposes a typed import failure, leaves no view, and retries from the beginning', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      const legacy = requireLegacyFacet(driverFactory.legacyHistoryImport, driverFactory.label);

      await withIntegrationFixture(`${activeDriver.id}-sacs-legacy-failure`, async (fixture) => {
        let source: SacsPreparedHistorySource | null = null;
        try {
          const target = await completedChat(fixture, activeDriver, 'FAIL_TARGET');
          const unrelated = await completedChat(fixture, activeDriver, 'FAIL_UNRELATED');
          source = await legacy.prepare(fixture, target.chatId, target.rows);

          await restartWithPreV5Chat(fixture, target.chatId);
          await expect(fixture.client.ping()).resolves.toBeDefined();
          await source.corrupt();

          const healthyChatId = fixture.newChatId();
          const unrelatedInput = marker(activeDriver.id, 'FAIL_UNRELATED_AFTER_RESTART');
          const unrelatedReply = marker(activeDriver.id, 'FAIL_UNRELATED_AFTER_RESTART_REPLY');
          activeDriver.scriptAssistant(fixture, unrelatedReply);
          const unrelatedTurn = await fixture.client.startChat(activeDriver.startRequest(fixture, {
            chatId: healthyChatId,
            projectPath: fixture.dirs.project,
            command: unrelatedInput,
          }));
          expect((await fixture.client.waitForTurnTerminal(
            healthyChatId,
            unrelatedTurn.turnId,
          )).type).toBe('agent-run-finished');

          const failure = await fixture.client.getMessages(target.chatId).then(
            () => null,
            (error: unknown) => error,
          );
          expect(failure).toBeInstanceOf(GarconApiError);
          expect(failure).toMatchObject({
            status: 503,
            body: {
              errorCode: 'TRANSCRIPT_UNAVAILABLE',
              retryable: true,
            },
          });
          expect(readCurrentView(fixture, target.chatId)).toBeNull();
          expect(conversationalContents(
            (await fixture.client.getMessages(unrelated.chatId)).messages,
          )).toEqual(unrelated.contents);
          expect(conversationalContents(
            (await fixture.client.getMessages(healthyChatId)).messages,
          )).toEqual([
            unrelatedInput,
            unrelatedReply,
          ]);

          await fixture.restartGarcon({ beforeStart: () => source!.restore() });

          const retried = await fixture.client.getMessages(target.chatId);
          expect(conversationalContents(retried.messages)).toEqual(target.contents);
          expectAddressedRows(retried.transcriptViewId, retried.messages);
          expect(readRows(fixture, target.chatId, retried.transcriptViewId)
            .filter((row) => row.kind === 'user-input' || row.kind === 'provider-row'))
            .toHaveLength(target.contents.length);
          activeDriver.assertSettled(fixture);
        } finally {
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    test('[TLV5-ADOPT.04-SACS-QUARANTINE-01] keeps recorded prior loss visible while importing the supported source', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      const legacy = requireLegacyFacet(driverFactory.legacyHistoryImport, driverFactory.label);

      await withIntegrationFixture(`${activeDriver.id}-sacs-legacy-quarantine`, async (fixture) => {
        try {
          const planted = await completedChat(fixture, activeDriver, 'QUARANTINE');
          await legacy.prepare(fixture, planted.chatId, planted.rows);
          const artifactId = `sacs-${activeDriver.id}-${crypto.randomUUID()}`;
          const errorCode = 'CARRYOVER_PARSE_FAILED';
          const artifactPath = join(
            fixture.dirs.workspace,
            'carryover-transcripts',
            'quarantine',
            `${artifactId}.json`,
          );

          await restartWithPreV5Chat(fixture, planted.chatId, async () => {
            await mkdir(join(fixture.dirs.workspace, 'carryover-transcripts', 'quarantine'), {
              recursive: true,
            });
            await writeFile(artifactPath, JSON.stringify({ artifactId, errorCode }));
            await updateRegistryChat(fixture, planted.chatId, (chat) => {
              chat.carryOverMigrationQuarantine = { artifactId, errorCode };
            });
          });

          const adopted = await fixture.client.getMessages(planted.chatId);
          const notices = messagesOfType(adopted.messages, 'transcript-notice');
          expect(notices).toHaveLength(1);
          expect(notices[0]).toMatchObject({
            content: `Some earlier chat history could not be migrated. Quarantine reference: ${artifactId}.`,
            detail: {
              type: 'carryover-migration-quarantine',
              artifactId,
              errorCode,
            },
          });
          expect(conversationalContents(adopted.messages)).toEqual(planted.contents);
          const rows = readRows(fixture, planted.chatId, adopted.transcriptViewId);
          expect(rows[0]).toMatchObject({
            kind: 'notice',
            detail: {
              type: 'carryover-migration-quarantine',
              artifactId,
              errorCode,
            },
          });
          expect(rows[1]?.kind).toBe('session');
          expect(readCurrentView(fixture, planted.chatId)?.contentStartOrdinal).toBe(2);
          expect(await Bun.file(artifactPath).exists()).toBe(true);
          activeDriver.assertSettled(fixture);
        } finally {
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    if (driverFactory.nativeHistoryImport) {
      const nativeHistoryImport = driverFactory.nativeHistoryImport;
      test('[TLV5-ADOPT.08-SACS-NATIVE-MISSING-01] preserves the current view when the selected native source is missing', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);

        await withIntegrationFixture(`${activeDriver.id}-sacs-native-missing`, async (fixture) => {
          try {
            const planted = await completedChat(fixture, activeDriver, 'NATIVE_MISSING');
            const source = await nativeHistoryImport.prepare(fixture, planted.chatId);
            const before = await fixture.client.getMessages(planted.chatId);

            await source.remove();
            await expectReloadFailurePreserves(fixture, planted.chatId, before);
            activeDriver.assertSettled(fixture);
          } finally {
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);

      test('[TLV5-ADOPT.08-SACS-NATIVE-READ-FAILURE-01] preserves the current view when the selected native source is unreadable', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);

        await withIntegrationFixture(`${activeDriver.id}-sacs-native-unreadable`, async (fixture) => {
          try {
            const planted = await completedChat(fixture, activeDriver, 'NATIVE_UNREADABLE');
            const source = await nativeHistoryImport.prepare(fixture, planted.chatId);
            const before = await fixture.client.getMessages(planted.chatId);

            await source.corrupt();
            await expectReloadFailurePreserves(fixture, planted.chatId, before);
            activeDriver.assertSettled(fixture);
          } finally {
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);

      test('[TLV5-ADOPT.08-SACS-NATIVE-EMPTY-01] replaces the current view from a validly empty native source', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);

        await withIntegrationFixture(`${activeDriver.id}-sacs-native-empty`, async (fixture) => {
          try {
            const planted = await completedChat(fixture, activeDriver, 'NATIVE_EMPTY');
            const source = await nativeHistoryImport.prepare(fixture, planted.chatId);
            const before = await fixture.client.getMessages(planted.chatId);

            await source.empty();
            await fixture.client.reloadChat(planted.chatId);

            const reloaded = await fixture.client.getMessages(planted.chatId);
            expect(reloaded.transcriptViewId).not.toBe(before.transcriptViewId);
            expect(reloaded.messages).toEqual([]);
            expect(readRows(fixture, planted.chatId, reloaded.transcriptViewId)).toEqual([
              expect.objectContaining({ kind: 'session' }),
            ]);
            activeDriver.assertSettled(fixture);
          } finally {
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);
    }

    if (driverFactory.id === 'opencode') {
      test('[TLV5-ADOPT.07-SACS-OPENCODE-SCOPED-01][TLV5-ADOPT.07-SACS-OPENCODE-NOTFOUND-01] fails a binding moved outside the recorded project directory until it returns', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);
        const legacy = requireLegacyFacet(driverFactory.legacyHistoryImport, driverFactory.label);
        const directoryScoped = requireDirectoryScopedFacet(legacy, driverFactory.label);

        await withIntegrationFixture(`${activeDriver.id}-sacs-scoped-legacy`, async (fixture) => {
          try {
            const inScope = await completedChat(fixture, activeDriver, 'SCOPED_PRESENT');
            const outOfScope = await completedChat(fixture, activeDriver, 'SCOPED_ABSENT');
            await legacy.prepare(fixture, inScope.chatId, inScope.rows);

            let moved: { restore(): Promise<void> } | undefined;
            await fixture.restartGarcon({
              beforeStart: async () => {
                await Promise.all([
                  removeLedger(fixture, inScope.chatId),
                  removeLedger(fixture, outOfScope.chatId),
                ]);
                moved = await directoryScoped.moveBindingToDifferentDirectory(
                  fixture,
                  outOfScope.chatId,
                );
              },
            });

            expect(conversationalContents(
              (await fixture.client.getMessages(inScope.chatId)).messages,
            )).toEqual(inScope.contents);
            const failure = await fixture.client.getMessages(outOfScope.chatId).then(
              () => null,
              (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(GarconApiError);
            expect(failure).toMatchObject({
              status: 503,
              body: {
                errorCode: 'TRANSCRIPT_UNAVAILABLE',
                retryable: true,
              },
            });
            expect(readCurrentView(fixture, outOfScope.chatId)).toBeNull();

            await fixture.restartGarcon({ beforeStart: () => moved!.restore() });

            const recovered = await fixture.client.getMessages(outOfScope.chatId);
            expect(conversationalContents(recovered.messages)).toEqual(outOfScope.contents);
            expect(readCurrentView(fixture, outOfScope.chatId)).not.toBeNull();
            activeDriver.assertSettled(fixture);
          } finally {
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);

      test('[TLV5-ADOPT.01-SACS-OPENCODE-ABSENCE-01] adopts a valid empty view only when the chat records no session', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);
        const legacy = requireLegacyFacet(driverFactory.legacyHistoryImport, driverFactory.label);

        await withIntegrationFixture(`${activeDriver.id}-sacs-legacy-absence`, async (fixture) => {
          try {
            const planted = await completedChat(fixture, activeDriver, 'ABSENT');
            const source = await legacy.prepare(fixture, planted.chatId, planted.rows);

            await restartWithPreV5Chat(fixture, planted.chatId, async () => {
              await source.remove();
              await updateRegistryChat(fixture, planted.chatId, (chat) => {
                chat.agentSessionId = null;
                chat.nativeSession = null;
                chat.nativeSeedReceipt = null;
              });
            });

            const adopted = await fixture.client.getMessages(planted.chatId);
            expect(adopted.messages).toEqual([]);
            expect(readCurrentView(fixture, planted.chatId)).toMatchObject({
              viewId: transcriptViewId(adopted.transcriptViewId),
            });
            expect(readRows(fixture, planted.chatId, adopted.transcriptViewId)).toEqual([]);
            activeDriver.assertSettled(fixture);
          } finally {
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);

      test('[TLV5-ADOPT.02-SACS-OPENCODE-MISSING-01] fails adoption while the recorded session is missing and recovers after restoration', async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);
        const legacy = requireLegacyFacet(driverFactory.legacyHistoryImport, driverFactory.label);

        await withIntegrationFixture(`${activeDriver.id}-sacs-legacy-missing`, async (fixture) => {
          try {
            const planted = await completedChat(fixture, activeDriver, 'MISSING');
            const source = await legacy.prepare(fixture, planted.chatId, planted.rows);
            const before = await fixture.client.getMessages(planted.chatId);
            const originalSessionDetail = requireSingleSessionDetail(
              readRows(fixture, planted.chatId, before.transcriptViewId),
            );

            await restartWithPreV5Chat(fixture, planted.chatId, () => source.remove());

            const failure = await fixture.client.getMessages(planted.chatId).then(
              () => null,
              (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(GarconApiError);
            expect(failure).toMatchObject({
              status: 503,
              body: {
                errorCode: 'TRANSCRIPT_UNAVAILABLE',
                retryable: true,
              },
            });
            expect(readCurrentView(fixture, planted.chatId)).toBeNull();

            await source.restore();

            const recovered = await fixture.client.getMessages(planted.chatId);
            expect(conversationalContents(recovered.messages)).toEqual(planted.contents);
            expect(requireSingleSessionDetail(
              readRows(fixture, planted.chatId, recovered.transcriptViewId),
            )).toEqual(originalSessionDetail);
            activeDriver.assertSettled(fixture);
          } finally {
            activeDriver.reset();
          }
        }, activeDriver.fixtureOptions);
      }, SACS_TIMEOUT_MS);
    }
  });
}

for (const driverFactory of sacsScriptedDriverFactories.filter((candidate) => (
  candidate.legacyHistoryImport === null
))) {
  describe(`SACS Direct native history: ${driverFactory.label}`, () => {
    let driver: SacsDriverEnvironment | undefined;

    beforeAll(async () => {
      driver = await driverFactory.start();
    });

    afterAll(async () => {
      await driver?.dispose();
    });

    test('[TLV5-ADOPT.08-SACS-DIRECT-RELOAD-01] reloads the exact provider-owned Direct history', async () => {
      const activeDriver = requireDriver(driver, driverFactory.label);
      await withIntegrationFixture(`${activeDriver.id}-sacs-native-reload`, async (fixture) => {
        try {
          const planted = await completedChat(fixture, activeDriver, 'NATIVE_RELOAD');
          const before = await fixture.client.getMessages(planted.chatId);

          await fixture.client.reloadChat(planted.chatId);

          const reloaded = await fixture.client.getMessages(planted.chatId);
          expect(reloaded.transcriptViewId).not.toBe(before.transcriptViewId);
          expect(conversationalContents(reloaded.messages)).toEqual(planted.contents);
          activeDriver.assertSettled(fixture);
        } finally {
          activeDriver.reset();
        }
      }, activeDriver.fixtureOptions);
    }, SACS_TIMEOUT_MS);

    for (const failure of ['missing', 'corrupt'] as const) {
      test(`[TLV5-ADOPT.08-SACS-DIRECT-${failure.toUpperCase()}-01] preserves the view when Direct history is ${failure}`, async () => {
        const activeDriver = requireDriver(driver, driverFactory.label);
        const nativeHistory = driverFactory.nativeHistoryImport;
        if (!nativeHistory) throw new Error(`${driverFactory.label} has no native history facet.`);
        await withIntegrationFixture(
          `${activeDriver.id}-sacs-native-${failure}`,
          async (fixture) => {
            try {
              const planted = await completedChat(fixture, activeDriver, `NATIVE_${failure}`);
              const source = await nativeHistory.prepare(fixture, planted.chatId);
              const before = await fixture.client.getMessages(planted.chatId);

              await source[failure === 'missing' ? 'remove' : 'corrupt']();
              await expectReloadFailurePreserves(fixture, planted.chatId, before);
              activeDriver.assertSettled(fixture);
            } finally {
              activeDriver.reset();
            }
          },
          activeDriver.fixtureOptions,
        );
      }, SACS_TIMEOUT_MS);
    }
  });
}

interface PlantedChat {
  readonly chatId: string;
  readonly contents: string[];
  readonly rows: readonly SacsLegacyTranscriptRow[];
}

async function completedChat(
  fixture: IntegrationFixture,
  driver: SacsDriverEnvironment,
  label: string,
): Promise<PlantedChat> {
  const firstInput = marker(driver.id, `${label}_FIRST_INPUT`);
  const firstReply = marker(driver.id, `${label}_FIRST_REPLY`);
  const secondInput = marker(driver.id, `${label}_SECOND_INPUT`);
  const secondReply = marker(driver.id, `${label}_SECOND_REPLY`);
  driver.scriptAssistant(fixture, firstReply);
  driver.scriptAssistant(fixture, secondReply);
  const chatId = fixture.newChatId();
  const first = await fixture.client.startChat(driver.startRequest(fixture, {
    chatId,
    projectPath: fixture.dirs.project,
    command: firstInput,
  }));
  expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type)
    .toBe('agent-run-finished');
  const second = await fixture.client.runChat(driver.runRequest(fixture, {
    chatId,
    command: secondInput,
  }));
  expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type)
    .toBe('agent-run-finished');
  const contents = [firstInput, firstReply, secondInput, secondReply];
  expect(conversationalContents((await fixture.client.getMessages(chatId)).messages))
    .toEqual(contents);
  return {
    chatId,
    contents,
    rows: [
      { role: 'user', content: firstInput, timestamp: SOURCE_TIMESTAMP },
      { role: 'assistant', content: firstReply, timestamp: SOURCE_TIMESTAMP },
      { role: 'user', content: secondInput, timestamp: SOURCE_TIMESTAMP },
      { role: 'assistant', content: secondReply, timestamp: SOURCE_TIMESTAMP },
    ],
  };
}

async function restartWithPreV5Chat(
  fixture: IntegrationFixture,
  chatId: string,
  prepareSource: () => Promise<void> = async () => {},
): Promise<void> {
  await fixture.restartGarcon({
    beforeStart: async () => {
      await prepareSource();
      await updateRegistryChat(fixture, chatId, () => {});
      await removeLedger(fixture, chatId);
    },
  });
}

async function updateRegistryChat(
  fixture: IntegrationFixture,
  chatId: string,
  update: (chat: Record<string, unknown>) => void,
): Promise<void> {
  const registryPath = join(fixture.dirs.workspace, 'chats.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
    sessions?: Record<string, Record<string, unknown>>;
  };
  const chat = registry.sessions?.[chatId];
  if (!chat) throw new Error(`SACS chat ${chatId} is missing from the registry.`);
  update(chat);
  await writeFile(registryPath, JSON.stringify(registry));
}

async function removeLedger(fixture: IntegrationFixture, chatId: string): Promise<void> {
  await rm(join(fixture.dirs.workspace, 'transcript-ledgers', chatId), {
    recursive: true,
    force: true,
  });
}

function requireDriver(
  driver: SacsDriverEnvironment | undefined,
  label: string,
): SacsDriverEnvironment {
  if (!driver) throw new Error(`${label} SACS driver was not initialized.`);
  return driver;
}

function requireLegacyFacet(
  facet: SacsLegacyHistoryImportFacet | null,
  label: string,
): SacsLegacyHistoryImportFacet {
  if (!facet) throw new Error(`${label} does not advertise legacy history import.`);
  return facet;
}

function requireDirectoryScopedFacet(
  facet: SacsLegacyHistoryImportFacet,
  label: string,
): SacsDirectoryScopedHistoryFacet {
  if (!facet.directoryScoped) {
    throw new Error(`${label} does not advertise directory-scoped history controls.`);
  }
  return facet.directoryScoped;
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
  viewId: string,
  messages: readonly { ordinal: number; message: ChatMessage }[],
): void {
  expect(messages.map((entry) => entry.ordinal)).toEqual(
    messages.map((entry) => entry.ordinal).toSorted((left, right) => left - right),
  );
  expect(new Set(messages.map((entry) => `${viewId}:${entry.ordinal}`)).size)
    .toBe(messages.length);
}

async function expectReloadFailurePreserves(
  fixture: IntegrationFixture,
  chatId: string,
  before: Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>,
): Promise<void> {
  const failure = await fixture.client.reloadChat(chatId).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(GarconWsRequestError);
  expect(failure).toMatchObject({ response: { code: 'HISTORY_LOAD_FAILED' } });

  const after = await fixture.client.getMessages(chatId);
  expect(after.transcriptViewId).toBe(before.transcriptViewId);
  expect(after.lastOrdinal).toBe(before.lastOrdinal);
  expect(after.messages).toEqual(before.messages);
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

function requireSingleSessionDetail(rows: readonly LedgerRow[]): LedgerSessionRow['detail'] {
  const sessions = rows.filter((row): row is LedgerSessionRow => row.kind === 'session');
  expect(sessions).toHaveLength(1);
  return structuredClone(sessions[0]!.detail);
}

async function readRegistrySessionBinding(fixture: IntegrationFixture, chatId: string) {
  const registryPath = join(fixture.dirs.workspace, 'chats.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
    sessions?: Record<string, Record<string, unknown>>;
  };
  const chat = registry.sessions?.[chatId];
  if (!chat || typeof chat.agentSessionId !== 'string') {
    throw new Error(`SACS chat ${chatId} has no persisted session binding.`);
  }
  return structuredClone({
    agentSessionId: chat.agentSessionId,
    nativeSession: chat.nativeSession ?? null,
    nativeSeedReceipt: chat.nativeSeedReceipt ?? null,
  });
}

function readCurrentView(fixture: IntegrationFixture, chatId: string) {
  const store = new TranscriptLedgerStore(join(fixture.dirs.workspace, 'transcript-ledgers'));
  try {
    return store.currentView(chatId);
  } finally {
    store.close();
  }
}
