import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const CHAT_ID = '1786120000000002';

describe('agent settings migration', () => {
  test('boots a v5 workspace after refreshing stale Amp settings and model values', async () => {
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
          agentSettingsById: {
            amp: { ownerId: 'amp', schemaVersion: 2, values: {} },
          },
        });
        expect(JSON.parse(await readFile(
          join(fixture.dirs.workspace, 'workspace-version.json'),
          'utf8',
        ))).toEqual({ version: 6 });
      },
      { prepareWorkspace: writeVersion5Workspace },
    );
  }, 30_000);
});

async function writeVersion5Workspace(directories: IntegrationDirectories): Promise<void> {
  await Promise.all([
    writeFile(
      join(directories.workspace, 'workspace-version.json'),
      JSON.stringify({ version: 5 }),
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
          thinkingMode: 'none',
        },
      },
    })),
  ]);
}
