import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';

const CHAT_ID = '1786120000000002';

describe('agent settings migration', () => {
  test('boots a v6 workspace after refreshing stale Amp settings and model values', async () => {
    await withIntegrationFixture(
      'agent-settings-migration',
      async (fixture) => {
        const registry = JSON.parse(await readFile(
          join(fixture.dirs.workspace, 'chats.json'),
          'utf8',
        ));
        expect(registry.sessions[CHAT_ID]).toMatchObject({
          agentId: 'amp',
          model: 'medium',
          thinkingMode: 'none',
          agentSettingsById: {
            amp: { ownerId: 'amp', schemaVersion: 2, values: {} },
          },
        });
        expect(JSON.parse(await readFile(
          join(fixture.dirs.workspace, 'workspace-version.json'),
          'utf8',
        ))).toEqual({ version: CURRENT_WORKSPACE_VERSION });

        await expect(fixture.client.startChat({
          origin: 'interactive',
          clientRequestId: randomUUID(),
          clientMessageId: randomUUID(),
          chatId: fixture.newChatId(),
          agentId: 'amp',
          projectPath: fixture.dirs.project,
          model: 'medium',
          permissionMode: 'default',
          thinkingMode: 'high',
          agentSettings: { ownerId: 'amp', schemaVersion: 2, values: {} },
          command: 'generic rejected start',
        })).rejects.toMatchObject({
          status: 422,
          body: { errorCode: 'VALIDATION_FAILED' },
        });

        await expect(fixture.client.patch('/api/v1/chats/execution-settings', {
          chatId: CHAT_ID,
          thinkingMode: 'high',
        })).rejects.toMatchObject({
          status: 422,
          body: { errorCode: 'VALIDATION_FAILED' },
        });

        await expect(fixture.client.forkRunChat({
          clientRequestId: randomUUID(),
          clientMessageId: randomUUID(),
          sourceChatId: CHAT_ID,
          chatId: fixture.newChatId(),
          command: 'generic rejected fork',
          thinkingMode: 'high',
        })).rejects.toMatchObject({
          status: 422,
          body: { errorCode: 'VALIDATION_FAILED' },
        });
      },
      { prepareWorkspace: writeVersion6Workspace },
    );
  }, 30_000);

  test('refreshes a pending Amp handoff and recent selection before recovery', async () => {
    await withIntegrationFixture('agent-settings-pending-handoff-migration', async (fixture) => {
      const chatId = fixture.newChatId();
      const sourceAgent = fixture.directAgents.openAi;
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'generic source input',
        projectPath: fixture.dirs.project,
        agent: sourceAgent,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      const history = await fixture.client.getMessages(chatId);
      const source = (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId);
      if (!source) throw new Error('Handoff migration source chat was not registered.');
      const targetEpoch = randomUUID();

      await fixture.restartGarcon({
        beforeStart: async () => {
          const projectSettings = JSON.parse(await readFile(
            join(fixture.dirs.workspace, 'project-settings.json'),
            'utf8',
          ));
          projectSettings.recentAgentSettings = [{
            agentId: 'amp',
            model: 'smart',
            apiProviderId: null,
            modelEndpointId: null,
            modelProtocol: null,
          }];
          projectSettings.executionDefaults.byAgent.amp = {
            thinkingMode: 'high',
            agentSettingsById: {
              amp: {
                ownerId: 'amp',
                schemaVersion: 1,
                values: { ampAgentMode: 'deep' },
              },
            },
          };
          projectSettings.ui = {
            ...projectSettings.ui,
            chatTitle: { agentId: 'amp', model: 'medium', thinkingMode: 'high' },
            agentSwitchCompaction: { agentId: 'amp', model: 'medium', thinkingMode: 'high' },
            commitMessage: { agentId: 'amp', model: 'medium', thinkingMode: 'high' },
            promptRefinement: { agentId: 'amp', model: 'medium', thinkingMode: 'high' },
          };
          await Promise.all([
            writeFile(
              join(fixture.dirs.workspace, 'workspace-version.json'),
              JSON.stringify({ version: 6 }),
            ),
            writeFile(
              join(fixture.dirs.workspace, 'project-settings.json'),
              JSON.stringify(projectSettings),
            ),
            writeFile(
              join(fixture.dirs.workspace, 'agent-ownership-journal.json'),
              `${JSON.stringify({
                version: 5,
                ownershipIntents: [{
                  version: 5,
                  operationId: `agent-handoff:${randomUUID()}`,
                  clientRequestId: randomUUID(),
                  submittedTargetHash: 'a'.repeat(64),
                  kind: 'handoff',
                  chatId,
                  phase: 'commit-decided',
                  source: {
                    agentId: source.agentId,
                    agentOwnershipEpoch: source.agentOwnershipEpoch,
                  },
                  target: {
                    execution: {
                      agentId: 'amp',
                      model: 'deep',
                      apiProviderId: null,
                      modelEndpointId: null,
                      modelProtocol: null,
                      permissionMode: 'default',
                      thinkingMode: 'high',
                      agentSettings: {
                        ownerId: 'amp',
                        schemaVersion: 1,
                        values: { ampAgentMode: 'deep' },
                      },
                    },
                    agentOwnershipEpoch: targetEpoch,
                  },
                  watermark: {
                    viewId: history.transcriptViewId,
                    ordinal: history.lastOrdinal,
                  },
                  createdAt: '2026-01-01T00:00:00.000Z',
                }],
              })}\n`,
            ),
          ]);
        },
      });

      await waitForPersistedChat({
        directories: fixture.dirs,
        chatId,
        timeoutMessage: 'Stale Amp handoff did not recover after settings migration.',
        select: (chat) => chat.agentId === 'amp' && chat.agentOwnershipEpoch === targetEpoch
          ? chat
          : null,
      });
      const registry = JSON.parse(await readFile(
        join(fixture.dirs.workspace, 'chats.json'),
        'utf8',
      ));
      expect(registry.sessions[chatId]).toMatchObject({
        agentId: 'amp',
        model: 'medium',
        thinkingMode: 'none',
        agentSettingsById: {
          amp: { ownerId: 'amp', schemaVersion: 2, values: {} },
        },
      });
      const migratedSettings = JSON.parse(await readFile(
        join(fixture.dirs.workspace, 'project-settings.json'),
        'utf8',
      ));
      expect(migratedSettings.recentAgentSettings).toEqual([{
        agentId: 'amp',
        model: 'medium',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
      }]);
      expect(migratedSettings.executionDefaults.byAgent.amp).toMatchObject({
        thinkingMode: 'none',
        agentSettingsById: {
          amp: { ownerId: 'amp', schemaVersion: 2, values: {} },
        },
      });
      for (const selection of [
        migratedSettings.ui.chatTitle,
        migratedSettings.ui.agentSwitchCompaction,
        migratedSettings.ui.commitMessage,
        migratedSettings.ui.promptRefinement,
      ]) {
        expect(selection).toMatchObject({
          agentId: 'amp',
          model: 'medium',
          thinkingMode: 'none',
        });
      }
    });
  }, 30_000);
});

async function writeVersion6Workspace(directories: IntegrationDirectories): Promise<void> {
  await Promise.all([
    writeFile(
      join(directories.workspace, 'workspace-version.json'),
      JSON.stringify({ version: 6 }),
    ),
    writeFile(join(directories.workspace, 'chats.json'), JSON.stringify({
      version: 5,
      sessions: {
        [CHAT_ID]: {
          agentId: 'amp',
          agentSessionId: null,
          nativeSession: null,
          agentOwnershipEpoch: 'amp-legacy-settings-epoch',
          agentSettingsById: {
            amp: {
              ownerId: 'amp',
              schemaVersion: 1,
              values: { ampAgentMode: 'smart' },
            },
          },
          projectPath: directories.project,
          tags: [],
          carryOverSegments: [],
          nativeSeedReceipt: null,
          carryOverMigrationQuarantine: null,
          model: 'smart',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
          lastReadAt: null,
          permissionMode: 'default',
          thinkingMode: 'high',
        },
      },
    })),
  ]);
}
