import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import { createCodexRolloutFileName } from '../../support/codex-rollout-filename.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('Codex history modes', () => {
  test('falls back to a frozen point fork when paginated native history cannot fork', async () => {
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
      const wholeFork = await fixture.client.forkChat({ sourceChatId, chatId: targetChatId });
      expect(wholeFork.chat.id).toBe(targetChatId);
      expect((await fixture.client.getMessages(targetChatId)).messages.map((entry) => (
        entry.message.type === 'user-message' || entry.message.type === 'assistant-message'
          ? entry.message.content
          : entry.message.type
      ))).toEqual(['paginated prompt', 'paginated answer']);

      const pointTargetChatId = fixture.newChatId();
      const pointFork = await fixture.client.forkChat({
        sourceChatId,
        chatId: pointTargetChatId,
        transcriptViewId: messages.transcriptViewId,
        upToOrdinal: messages.messages[0]!.ordinal,
      });
      expect(pointFork.chat.id).toBe(pointTargetChatId);
      expect((await fixture.client.getMessages(pointTargetChatId)).messages.map((entry) => (
        entry.message.type === 'user-message' || entry.message.type === 'assistant-message'
          ? entry.message.content
          : entry.message.type
      ))).toEqual(['paginated prompt']);
      expect(await readFile(sourceNativePath, 'utf8')).toBe(sourceBefore);

      const registry = JSON.parse(
        await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
      ) as { sessions: Record<string, { nextForkOrdinal?: number }> };
      expect(registry.sessions[targetChatId]).toBeDefined();
      expect(registry.sessions[pointTargetChatId]).toBeDefined();
      expect(registry.sessions[sourceChatId]?.nextForkOrdinal).toBe(3);
      const sessionDirectory = dirname(sourceNativePath);
      const sessionFiles = (await readdir(sessionDirectory)).filter((name) => name.endsWith('.jsonl'));
      expect(sessionFiles).toEqual([sourceNativePath.split('/').at(-1)!]);
      // The user-message row anchors no native point, so the point fork stays the frozen
      // session-less copy; only the whole fork reaches the app-server and is refused there.
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
          version: 5,
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
              carryOverSegments: [],
              nativeSeedReceipt: null,
              carryOverMigrationQuarantine: null,
            },
          },
        }));
      },
    });
  });

  test('forks a paginated point natively through the turn named by its anchor identity', async () => {
    const sourceChatId = String(Date.now() * 1_000 + 2);
    const sourceAgentSessionId = randomUUID();
    let sourceNativePath = '';
    let forkParamsLogPath = '';
    const serverEnvironment = {
      GARCON_CODEX_CLI: fileURLToPath(new URL(
        '../../support/fake-codex-app-server.ts',
        import.meta.url,
      )),
      PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      INTEGRATION_CODEX_THREAD_ID: sourceAgentSessionId,
      INTEGRATION_CODEX_NATIVE_PATH: '',
      INTEGRATION_CODEX_FORK_JSONL: '1',
      INTEGRATION_CODEX_FORK_PARAMS_LOG: '',
    };

    await withIntegrationFixture('codex-paginated-point-fork', async (fixture) => {
      const messages = await fixture.client.getMessages(sourceChatId);
      expect(messages.messages.map((entry) => (
        entry.message.type === 'user-message' || entry.message.type === 'assistant-message'
          ? entry.message.content
          : entry.message.type
      ))).toEqual([
        'first prompt',
        'first answer',
        'second prompt',
        'second answer',
      ]);
      const sourceBefore = await readFile(sourceNativePath, 'utf8');

      const targetChatId = fixture.newChatId();
      const pointFork = await fixture.client.forkChat({
        sourceChatId,
        chatId: targetChatId,
        transcriptViewId: messages.transcriptViewId,
        upToOrdinal: messages.messages[1]!.ordinal,
      });
      expect(pointFork.chat.id).toBe(targetChatId);
      expect((await fixture.client.getMessages(targetChatId)).messages.map((entry) => (
        entry.message.type === 'user-message' || entry.message.type === 'assistant-message'
          ? entry.message.content
          : entry.message.type
      ))).toEqual(['first prompt', 'first answer']);

      const registry = JSON.parse(
        await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
      ) as {
        sessions: Record<string, { agentSessionId?: string | null; nativeSession?: unknown }>
      };
      const forkedSessionId = registry.sessions[targetChatId]?.agentSessionId;
      expect(typeof forkedSessionId).toBe('string');
      expect(forkedSessionId).not.toBe(sourceAgentSessionId);
      const sessionDirectory = dirname(sourceNativePath);
      const sessionFiles = (await readdir(sessionDirectory)).filter((name) => name.endsWith('.jsonl'));
      expect(sessionFiles.length).toBe(2);

      const forkParams = (await readFile(forkParamsLogPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(forkParams).toEqual([{
        threadId: sourceAgentSessionId,
        cwd: fixture.dirs.project,
        model: 'gpt-5.6-sol',
        ephemeral: false,
        excludeTurns: true,
        path: sourceNativePath,
        lastTurnId: 'turn-1',
      }]);
      expect(await readFile(sourceNativePath, 'utf8')).toBe(sourceBefore);
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
          createCodexRolloutFileName(sourceAgentSessionId, new Date('2026-07-20T00:00:00.000Z')),
        );
        serverEnvironment.INTEGRATION_CODEX_NATIVE_PATH = sourceNativePath;
        forkParamsLogPath = join(directories.root, 'codex-fork-params.log');
        serverEnvironment.INTEGRATION_CODEX_FORK_PARAMS_LOG = forkParamsLogPath;
        await mkdir(dirname(sourceNativePath), { recursive: true });
        const timestamp = '2026-07-20T00:00:00.000Z';
        const turnMetadata = (turnId: string) => ({
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        });
        const userItem = (id: string, text: string, turnId: string) => JSON.stringify({
          timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            id,
            role: 'user',
            content: [{ type: 'input_text', text }],
            ...turnMetadata(turnId),
          },
        });
        const assistantItem = (id: string, text: string) => JSON.stringify({
          timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            id,
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        });
        await writeFile(sourceNativePath, [
          JSON.stringify({
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
          }),
          userItem('item-1', 'first prompt', 'turn-1'),
          assistantItem('item-2', 'first answer'),
          userItem('item-3', 'second prompt', 'turn-3'),
          assistantItem('item-4', 'second answer'),
          '',
        ].join('\n'));
        await writeFile(
          join(directories.workspace, 'workspace-version.json'),
          JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }),
        );
        await writeFile(join(directories.workspace, 'chats.json'), JSON.stringify({
          version: 5,
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
              carryOverSegments: [],
              nativeSeedReceipt: null,
              carryOverMigrationQuarantine: null,
            },
          },
        }));
      },
    });
  });
});
