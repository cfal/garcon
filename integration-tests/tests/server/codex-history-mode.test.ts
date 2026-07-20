import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import { GarconApiError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('Codex history modes', () => {
  test('rejects a paginated full fork without creating a JSONL fallback target', async () => {
    const sourceChatId = String(Date.now() * 1_000 + 1);
    const sourceAgentSessionId = randomUUID();
    let sourceNativePath = '';
    let callLogPath = '';
    const serverEnvironment = {
      GARCON_CODEX_CLI: fileURLToPath(new URL(
        '../../support/fake-codex-app-server.ts',
        import.meta.url,
      )),
      PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      INTEGRATION_CODEX_THREAD_ID: sourceAgentSessionId,
      INTEGRATION_CODEX_NATIVE_PATH: '',
      INTEGRATION_CODEX_HISTORY_FIXTURE: '1',
      INTEGRATION_CODEX_CALL_LOG: '',
    };

    await withIntegrationFixture('codex-paginated-full-fork', async (fixture) => {
      const messages = await fixture.client.getMessages(sourceChatId);
      expect(messages.messages.map((entry) => (
        entry.message.type === 'user-message' || entry.message.type === 'assistant-message'
          ? entry.message.content
          : entry.message.type
      ))).toEqual([
        'paginated prompt',
        'paginated answer',
      ]);
      const sourceBefore = await readFile(sourceNativePath, 'utf8');
      const targetChatId = fixture.newChatId();
      let failure: unknown;
      try {
        await fixture.client.forkChat({ sourceChatId, chatId: targetChatId });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(GarconApiError);
      expect(failure).toMatchObject({
        status: 422,
        body: {
          success: false,
          errorCode: 'OPERATION_UNSUPPORTED',
          retryable: false,
        },
      });

      const pointTargetChatId = fixture.newChatId();
      let pointFailure: unknown;
      try {
        await fixture.client.forkChat({
          sourceChatId,
          chatId: pointTargetChatId,
          upToSeq: 1,
        });
      } catch (error) {
        pointFailure = error;
      }
      expect(pointFailure).toMatchObject({
        status: 422,
        body: {
          success: false,
          errorCode: 'OPERATION_UNSUPPORTED',
          retryable: false,
        },
      });
      expect(await readFile(sourceNativePath, 'utf8')).toBe(sourceBefore);

      const registry = JSON.parse(
        await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
      ) as { sessions: Record<string, { nextForkOrdinal?: number }> };
      expect(registry.sessions[targetChatId]).toBeUndefined();
      expect(registry.sessions[pointTargetChatId]).toBeUndefined();
      expect(registry.sessions[sourceChatId]?.nextForkOrdinal).toBe(1);
      const sessionDirectory = dirname(sourceNativePath);
      const sessionFiles = (await readdir(sessionDirectory)).filter((name) => name.endsWith('.jsonl'));
      expect(sessionFiles).toEqual([sourceNativePath.split('/').at(-1)!]);
      expect(await readFile(callLogPath, 'utf8')).toBe('thread/fork\n');
    }, {
      serverEnvironment,
      async prepareWorkspace(directories) {
        sourceNativePath = join(
          directories.home,
          '.codex',
          'sessions',
          '2026',
          '07',
          '20',
          `rollout-${sourceAgentSessionId}.jsonl`,
        );
        serverEnvironment.INTEGRATION_CODEX_NATIVE_PATH = sourceNativePath;
        callLogPath = join(directories.root, 'codex-calls.log');
        serverEnvironment.INTEGRATION_CODEX_CALL_LOG = callLogPath;
        await mkdir(dirname(sourceNativePath), { recursive: true });
        const timestamp = '2026-07-20T00:00:00.000Z';
        await writeFile(sourceNativePath, `${JSON.stringify({
          timestamp,
          type: 'session_meta',
          payload: {
            id: sourceAgentSessionId,
            timestamp,
            cwd: directories.project,
            originator: 'codex_cli_rs',
            cli_version: '0.144.1',
            source: 'cli',
            model_provider: 'openai',
            history_mode: 'paginated',
            history_base: null,
          },
        })}\n`);
        await writeFile(
          join(directories.workspace, 'workspace-version.json'),
          JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }),
        );
        await writeFile(join(directories.workspace, 'chats.json'), JSON.stringify({
          version: 3,
          sessions: {
            [sourceChatId]: {
              agentId: 'codex',
              nativeSession: {
                ownerId: 'codex',
                schemaVersion: 1,
                value: { path: sourceNativePath, agentSessionId: sourceAgentSessionId },
              },
              agentOwnershipEpoch: randomUUID(),
              agentSettingsById: {},
              projectPath: directories.project,
              tags: [],
              agentSessionId: sourceAgentSessionId,
              nextForkOrdinal: 1,
              model: 'gpt-5.6-sol',
              apiProviderId: null,
              modelEndpointId: null,
              modelProtocol: null,
              lastReadAt: null,
              permissionMode: 'default',
              thinkingMode: 'none',
            },
          },
        }));
      },
    });
  });
});
