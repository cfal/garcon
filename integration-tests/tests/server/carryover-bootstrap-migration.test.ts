import { describe, expect, test } from 'bun:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
} from '../../../common/agents.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import {
  type IntegrationDirectories,
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const CHAT_ID = '1786120000000001';
const TIMESTAMP = '2026-08-07T00:00:00.000Z';

describe('carryover bootstrap migration', () => {
  test('boots a v3 workspace, preserves multi-segment history, and finalizes on restart', async () => {
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
          version: 5,
        });
        expect(await readJson<{
          version: number;
          ownershipIntents: unknown[];
          transferCleanup: unknown[];
        }>(fixture, 'agent-ownership-journal.json')).toEqual({
          version: 3,
          ownershipIntents: [],
          transferCleanup: [],
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
  expect(userContents(history.messages)).toEqual(['legacy-a-user', 'legacy-b-user']);
  expect(assistantContents(history.messages)).toEqual([
    'legacy-a-assistant',
    'legacy-b-assistant',
  ]);
  expect(messagesOfType(history.messages, 'agent-switch').map((message) => [
    message.fromAgentId,
    message.toAgentId,
  ])).toEqual([
    [
      DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
    ],
    [
      DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
      DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
    ],
  ]);
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
