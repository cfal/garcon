import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
import { encodeCarryOverPages } from '../../../server/chats/carryover-page-codec.js';
import { rollbackLegacyCarryOverMigration } from '../../../server/chats/chat-carryover-rollback.js';
import { ChatRegistry } from '../../../server/chats/store.js';
import { transcriptViewId } from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import {
  type IntegrationDirectories,
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const CHAT_ID = '1786120000000001';
const POST_MIGRATION_CHAT_ID = '1786120000000002';
const HEALTHY_LINKED_CHAT_ID = '1786120000000003';
const HEALTHY_LINKED_NODE_ID = '55555555-5555-4555-8555-555555555555';
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
          version: CURRENT_WORKSPACE_VERSION,
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
          version: CURRENT_WORKSPACE_VERSION,
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
              preambleSelection: { revision: 0, orderedPreambleIds: [] },
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

  test('boots after quarantining a chat whose linked manifest is missing', async () => {
    await withIntegrationFixture(
      'carryover-missing-linked-manifest',
      async (fixture) => {
        const registry = await readJson<RegistryFile>(fixture, 'chats.json');
        expect(registry.version).toBe(5);
        expect(registry.sessions[CHAT_ID]).toMatchObject({
          carryOverSegments: [],
          carryOverMigrationQuarantine: {
            errorCode: 'MISSING_CARRYOVER_NODE',
          },
        });
        expect((await fixture.client.listChats()).sessions.map((chat) => chat.id))
          .toEqual(expect.arrayContaining([CHAT_ID, HEALTHY_LINKED_CHAT_ID]));

        await fixture.restartGarcon();

        expect(await readdir(join(
          fixture.dirs.workspace,
          'carryover-transcripts',
          'nodes',
        ))).toContain(HEALTHY_LINKED_NODE_ID);
        expect((await readJson<RegistryFile>(fixture, 'chats.json')).sessions[CHAT_ID])
          .toMatchObject({
            carryOverMigrationQuarantine: { errorCode: 'MISSING_CARRYOVER_NODE' },
          });
        const healthyHistory = await fixture.client.getMessages(HEALTHY_LINKED_CHAT_ID);
        expect(healthyHistory.messages.map(({ message }) => renderedIdentity(message))).toEqual([
          { type: 'user-message', content: 'healthy-linked-user' },
          {
            type: 'agent-switch',
            fromAgentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
            toAgentId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
            fromModel: 'legacy-openai-model',
            toModel: 'legacy-anthropic-model',
          },
        ]);
      },
      { prepareWorkspace: writeMissingManifestWorkspace },
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
    readonly carryOverMigrationQuarantine?: {
      readonly errorCode: string;
    } | null;
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

async function writeMissingManifestWorkspace(directories: IntegrationDirectories): Promise<void> {
  const agentA = DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID;
  const agentB = DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID;
  const nodeDirectory = join(
    directories.workspace,
    'carryover-transcripts',
    'nodes',
    HEALTHY_LINKED_NODE_ID,
  );
  const messages = [new UserMessage(TIMESTAMP, 'healthy-linked-user')];
  const encoded = await encodeCarryOverPages(messages);
  await mkdir(join(nodeDirectory, 'pages'), { recursive: true });
  await Promise.all(encoded.map((page) => (
    writeFile(join(nodeDirectory, page.descriptor.file), page.bytes)
  )));
  await Promise.all([
    writeFile(
      join(directories.workspace, 'workspace-version.json'),
      JSON.stringify({ version: 3 }),
    ),
    writeFile(join(directories.workspace, 'chats.json'), JSON.stringify({
      version: 4,
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
          tags: [],
          model: 'legacy-openai-model',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
          lastReadAt: null,
          permissionMode: 'default',
          thinkingMode: 'none',
          carryOverHeadId: '44444444-4444-4444-8444-444444444444',
          nativeSeedReceipt: null,
          carryOverMigrationQuarantine: null,
        },
        [HEALTHY_LINKED_CHAT_ID]: {
          agentId: agentB,
          agentSessionId: null,
          nativeSession: null,
          agentOwnershipEpoch: 'legacy-anthropic-epoch',
          agentSettingsById: {
            [agentA]: { ownerId: agentA, schemaVersion: 1, values: {} },
            [agentB]: { ownerId: agentB, schemaVersion: 1, values: {} },
          },
          projectPath: directories.project,
          tags: [],
          model: 'legacy-anthropic-model',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
          lastReadAt: null,
          permissionMode: 'default',
          thinkingMode: 'none',
          carryOverHeadId: HEALTHY_LINKED_NODE_ID,
          nativeSeedReceipt: null,
          carryOverMigrationQuarantine: null,
        },
      },
    })),
    writeFile(
      join(directories.workspace, 'agent-ownership-journal.json'),
      JSON.stringify({ version: 2, ownershipIntents: [], transferCleanup: [] }),
    ),
    writeFile(join(nodeDirectory, 'manifest.json'), JSON.stringify({
      version: 1,
      kind: 'materialized',
      id: HEALTHY_LINKED_NODE_ID,
      parentId: null,
      createdAt: TIMESTAMP,
      source: {
        agentId: agentA,
        model: 'legacy-openai-model',
        nativeSessionId: 'legacy-openai-session',
        nativeRevision: 'legacy-openai-revision',
      },
      boundary: {
        kind: 'handoff',
        targetAtCapture: { agentId: agentB, model: 'legacy-anthropic-model' },
      },
      seedSanitation: 'not-applicable',
      messageCount: messages.length,
      pages: encoded.map((page) => page.descriptor),
    })),
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
