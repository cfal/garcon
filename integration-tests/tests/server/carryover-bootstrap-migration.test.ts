import { describe, expect, test } from 'bun:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
} from '../../../common/agents.js';
import {
  AssistantMessage,
  type ChatMessage,
  UserMessage,
} from '../../../common/chat-types.js';
import { rollbackLegacyCarryOverMigration } from '../../../server/chats/chat-carryover-rollback.js';
import { ChatRegistry } from '../../../server/chats/store.js';
import { transcriptViewId } from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import {
  type IntegrationDirectories,
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const CHAT_ID = '1786120000000001';
const POST_MIGRATION_CHAT_ID = '1786120000000002';
const TIMESTAMP = '2026-08-07T00:00:00.000Z';

describe('carryover bootstrap migration', () => {
  test('[TLV5-ADOPT.09-SERVER-MULTI-SEGMENT-01] boots a v3 workspace with its complete ordered ownership history', async () => {
    await withIntegrationFixture(
      'carryover-bootstrap-migration',
      async (fixture) => {
        const firstRegistry = await readJson<RegistryFile>(fixture, 'chats.json');
        const firstEntry = firstRegistry.sessions[CHAT_ID];
        if (!firstEntry) throw new Error('Migrated chat is missing');
        expect(firstEntry.carryOverSegments).toHaveLength(2);
        const migratedSegments = firstEntry.carryOverSegments;

        expect(firstRegistry.version).toBe(5);
        expect(await readJson<{ version: number }>(fixture, 'workspace-version.json')).toEqual({
          version: 6,
        });
        expect(await readJson<{
          version: number;
          ownershipIntents: unknown[];
        }>(fixture, 'agent-ownership-journal.json')).toEqual({
          version: 5,
          ownershipIntents: [],
        });
        const firstMarker = await readJson<MigrationMarker>(
          fixture,
          'carryover-transcripts/migration-v2.json',
        );
        expect(firstMarker).toMatchObject({
          phase: 'complete',
          segmentCount: 2,
          rollbackSafe: true,
        });
        for (const ref of migratedSegments) {
          const index = await readJson<Record<string, unknown>>(
            fixture,
            `carryover-transcripts/segments/${ref.id}/segment.json`,
          );
          expect(index).toMatchObject({ id: ref.id, messageCount: 2 });
          expect(index).not.toHaveProperty('parentId');
          expect(index).not.toHaveProperty('sourceNodeId');
          expect(index).not.toHaveProperty('agentId');
          expect(index).not.toHaveProperty('model');
        }
        expect(await Bun.file(join(fixture.dirs.workspace, 'chat-carryover.json')).exists())
          .toBe(false);
        expect(await migratedCarryOverFiles(fixture)).toHaveLength(1);
        expect(await readdir(join(fixture.dirs.workspace, 'migration-backups'))).toHaveLength(2);

        await expectMigratedHistory(fixture);

        await fixture.restartGarcon();

        const restartedRegistry = await readJson<RegistryFile>(fixture, 'chats.json');
        expect(restartedRegistry.sessions[CHAT_ID]?.carryOverSegments).toEqual(migratedSegments);
        const finalizedMarker = await readJson<MigrationMarker>(
          fixture,
          'carryover-transcripts/migration-v2.json',
        );
        expect(finalizedMarker).toMatchObject({
          phase: 'complete',
          segmentCount: 2,
          rollbackSafe: false,
        });
        expect(await migratedCarryOverFiles(fixture)).toEqual([]);
        expect(await readdir(join(fixture.dirs.workspace, 'migration-backups'))).toEqual([]);
        await expectMigratedHistory(fixture);
      },
      { prepareWorkspace: writeLegacyWorkspace },
    );
  }, 30_000);

  test('resumes an interrupted rollback before the version ladder', async () => {
    await withIntegrationFixture(
      'carryover-rollback-resume',
      async (fixture) => {
        // The first boot migrated the workspace; backups are still present.
        await fixture.restartGarcon({
          beforeStart: async () => {
            // The crash window that used to wedge the boot: the legacy journal
            // is restored and the resume marker written, but the registry and
            // the workspace version are still on the migrated side, so the
            // version-gated ladder would never invoke its migration callback.
            await writeFile(
              join(fixture.dirs.workspace, 'agent-ownership-journal.json'),
              JSON.stringify({ version: 1, intents: [] }),
            );
            const markerPath = join(
              fixture.dirs.workspace,
              'carryover-transcripts',
              'migration-v2.json',
            );
            const marker = JSON.parse(await readFile(markerPath, 'utf8'));
            await writeFile(markerPath, JSON.stringify({ ...marker, phase: 'rolling-back' }));
          },
        });

        // The rollback finished from its marker, then the boot re-migrated.
        expect(await readJson<RegistryFile>(fixture, 'chats.json')).toMatchObject({ version: 5 });
        expect(await readJson<{ version: number }>(fixture, 'agent-ownership-journal.json'))
          .toMatchObject({ version: 5 });
        expect(await readJson<{ version: number }>(fixture, 'workspace-version.json')).toEqual({
          version: 6,
        });
        expect(await readJson<MigrationMarker>(fixture, 'carryover-transcripts/migration-v2.json'))
          .toMatchObject({ phase: 'complete', rollbackSafe: true });
        await expectMigratedHistory(fixture);
      },
      { prepareWorkspace: writeLegacyWorkspace },
    );
  }, 30_000);

  test('refuses rollback between boots after the registry gains a chat', async () => {
    await withIntegrationFixture(
      'carryover-rollback-registry-divergence',
      async (fixture) => {
        await fixture.restartGarcon({
          beforeStart: async () => {
            const registry = new ChatRegistry(fixture.dirs.workspace);
            await registry.init();
            registry.addChat({
              id: POST_MIGRATION_CHAT_ID,
              agentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
              model: 'post-migration-model',
              projectPath: fixture.dirs.project,
              agentSettingsById: {},
              parentChat: null,
            });
            await registry.flush();

            await expect(rollbackLegacyCarryOverMigration(fixture.dirs.workspace))
              .rejects.toThrow('unsafe after the registry changed');
          },
        });

        expect((await fixture.client.listChats()).sessions.map((chat) => chat.id)).toEqual(
          expect.arrayContaining([CHAT_ID, POST_MIGRATION_CHAT_ID]),
        );
        await expectMigratedHistory(fixture);
      },
      { prepareWorkspace: writeLegacyWorkspace },
    );
  }, 30_000);
});

interface RegistryFile {
  readonly version: number;
  readonly sessions: Record<string, {
    readonly carryOverSegments: readonly {
      readonly id: string;
      readonly agentId: string;
      readonly model: string;
      readonly storedMessageCount: number;
      readonly visibleMessageCount: number;
    }[];
  }>;
}

interface MigrationMarker {
  readonly phase: string;
  readonly segmentCount: number;
  readonly rollbackSafe: boolean;
}

async function writeLegacyWorkspace(directories: IntegrationDirectories): Promise<void> {
  const agentA = DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID;
  const agentB = DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID;
  await Promise.all([
    writeFile(
      join(directories.workspace, 'workspace-version.json'),
      JSON.stringify({ version: 3 }),
    ),
    writeFile(join(directories.workspace, 'chats.json'), JSON.stringify({
      version: 3,
      sessions: {
        [CHAT_ID]: {
          agentId: agentA,
          agentSessionId: null,
          nativeSession: null,
          agentOwnershipEpoch: 'legacy-openai-epoch',
          agentSettingsById: {
            [agentA]: { ownerId: agentA, schemaVersion: 1, values: {} },
            [agentB]: { ownerId: agentB, schemaVersion: 1, values: {} },
          },
          projectPath: directories.project,
          tags: ['legacy-carryover'],
          model: 'legacy-openai-model',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
          lastReadAt: null,
          permissionMode: 'default',
          thinkingMode: 'none',
        },
      },
    })),
    writeFile(join(directories.workspace, 'chat-carryover.json'), JSON.stringify({
      version: 4,
      chats: {
        [CHAT_ID]: {
          revision: 1,
          segments: [
            {
              agentId: agentA,
              model: 'legacy-openai-model',
              messages: [
                new UserMessage(TIMESTAMP, 'legacy-a-user'),
                new AssistantMessage(TIMESTAMP, 'legacy-a-assistant'),
              ],
              at: TIMESTAMP,
              boundary: true,
              boundaryTarget: { agentId: agentB, model: 'legacy-anthropic-model' },
            },
            {
              agentId: agentB,
              model: 'legacy-anthropic-model',
              messages: [
                new UserMessage(TIMESTAMP, 'legacy-b-user'),
                new AssistantMessage(TIMESTAMP, 'legacy-b-assistant'),
              ],
              at: TIMESTAMP,
              boundary: true,
              boundaryTarget: { agentId: agentA, model: 'legacy-openai-model' },
            },
          ],
        },
      },
    })),
    writeFile(
      join(directories.workspace, 'agent-ownership-journal.json'),
      JSON.stringify({ version: 1, intents: [] }),
    ),
  ]);
}

async function expectMigratedHistory(
  fixture: IntegrationFixture,
): Promise<void> {
  const history = await fixture.client.getMessages(CHAT_ID);
  expect(history.messages.map(({ message }) => renderedIdentity(message))).toEqual([
    { type: 'user-message', content: 'legacy-a-user' },
    { type: 'assistant-message', content: 'legacy-a-assistant' },
    {
      type: 'agent-switch',
      fromAgentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      toAgentId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
      fromModel: 'legacy-openai-model',
      toModel: 'legacy-anthropic-model',
    },
    { type: 'user-message', content: 'legacy-b-user' },
    { type: 'assistant-message', content: 'legacy-b-assistant' },
    {
      type: 'agent-switch',
      fromAgentId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
      toAgentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      fromModel: 'legacy-anthropic-model',
      toModel: 'legacy-openai-model',
    },
  ]);

  const ledger = new TranscriptLedgerStore(
    join(fixture.dirs.workspace, 'transcript-ledgers'),
  );
  try {
    const rows = ledger.page(
      CHAT_ID,
      transcriptViewId(history.transcriptViewId),
      20,
    ).rows;
    expect(rows.map((row) => row.kind)).toEqual([
      'user-input',
      'provider-row',
      'agent-switch',
      'user-input',
      'provider-row',
      'agent-switch',
    ]);
  } finally {
    ledger.close();
  }
}

function renderedIdentity(message: ChatMessage) {
  if (message.type === 'agent-switch') {
    return {
      type: message.type,
      fromAgentId: message.fromAgentId,
      toAgentId: message.toAgentId,
      fromModel: message.fromModel,
      toModel: message.toModel,
    };
  }
  if (message.type === 'user-message' || message.type === 'assistant-message') {
    return { type: message.type, content: message.content };
  }
  throw new Error(`Unexpected frozen-prefix message ${message.type}`);
}

async function migratedCarryOverFiles(
  fixture: { readonly dirs: IntegrationDirectories },
): Promise<string[]> {
  return (await readdir(fixture.dirs.workspace)).filter((file) => (
    file.startsWith('chat-carryover.v5.migrated.')
  ));
}

async function readJson<T = unknown>(
  fixture: { readonly dirs: IntegrationDirectories },
  relativePath: string,
): Promise<T> {
  return JSON.parse(
    await readFile(join(fixture.dirs.workspace, relativePath), 'utf8'),
  ) as T;
}
