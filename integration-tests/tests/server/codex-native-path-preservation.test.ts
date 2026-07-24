import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import type { ChatMessage } from '../../../common/chat-types.js';
import { GarconApiError } from '../../support/garcon-client.js';
import { createCodexRolloutFileName } from '../../support/codex-rollout-filename.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const timestamp = '2026-07-24T00:00:00.000Z';

describe('Codex native transcript path preservation', () => {
  test('keeps a new cross-agent fork attached to the same transcript across restarts', async () => {
    const sourceChatId = String(Date.now() * 1_000 + 1);
    const sourceAgentSessionId = randomUUID();
    const cursorMarker = `cursorcarry${randomUUID().replaceAll('-', '')}`;
    const codexMarker = `codexnative${randomUUID().replaceAll('-', '')}`;
    let sourceNativePath = '';

    await withIntegrationFixture(
      'codex-native-path-preservation',
      async (fixture) => {
        const source = await fixture.client.getMessages(sourceChatId);
        expect(messageLabels(source.messages.map((entry) => entry.message))).toEqual([
          cursorMarker,
          `cursor-answer-${cursorMarker}`,
          'agent-switch',
          codexMarker,
          `codex-answer-${codexMarker}`,
        ]);

        const targetChatId = fixture.newChatId();
        await fixture.client.forkChat({
          sourceChatId,
          chatId: targetChatId,
          upToSeq: source.messages.length,
        });

        const beforeRestart = await readNativeSession(fixture.dirs.workspace, targetChatId);
        const beforeRestartPath = beforeRestart.path;
        expect(beforeRestartPath).toBeTruthy();
        if (!beforeRestartPath) {
          throw new Error('Forked Codex chat did not persist a native path');
        }
        expect(beforeRestartPath).not.toBe(sourceNativePath);
        expect(basename(beforeRestartPath)).toMatch(
          /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/,
        );

        await fixture.restartGarcon();

        const afterRestart = await readNativeSession(fixture.dirs.workspace, targetChatId);
        expect(afterRestart).toEqual(beforeRestart);
        const reloaded = await fixture.client.getMessages(targetChatId);
        expect(messageLabels(reloaded.messages.map((entry) => entry.message))).toEqual(
          messageLabels(source.messages.map((entry) => entry.message)),
        );

        const settings = await fixture.client.updateSettings({
          features: { transcriptSearch: { enabled: true } },
        });
        expect(settings.settings.features.transcriptSearch.enabled).toBe(true);
        for (const marker of [cursorMarker, codexMarker]) {
          const search = await fixture.client.waitForChatSearch(
            { query: marker, chatIds: [targetChatId], limit: 20 },
            (response) =>
              response.index.pendingChatCount === 0 &&
              response.results.some((result) => result.chatId === targetChatId),
          );
          expect(search.results.map((result) => result.chatId)).toContain(targetChatId);
        }

        await fixture.restartGarcon();
        await expect(readNativeSession(fixture.dirs.workspace, targetChatId)).resolves.toEqual(
          beforeRestart,
        );
        const twiceReloaded = await fixture.client.getMessages(targetChatId);
        expect(messageLabels(twiceReloaded.messages.map((entry) => entry.message))).toEqual(
          messageLabels(source.messages.map((entry) => entry.message)),
        );
      },
      {
        serverEnvironment: codexServerEnvironment(),
        async prepareWorkspace(directories) {
          sourceNativePath = await writeCodexTranscript({
            home: directories.home,
            projectPath: directories.project,
            threadId: sourceAgentSessionId,
            userContent: codexMarker,
            assistantContent: `codex-answer-${codexMarker}`,
          });
          await seedWorkspace({
            workspace: directories.workspace,
            chatId: sourceChatId,
            threadId: sourceAgentSessionId,
            nativePath: sourceNativePath,
            projectPath: directories.project,
            carryUser: cursorMarker,
            carryAssistant: `cursor-answer-${cursorMarker}`,
          });
        },
      },
    );
  }, 20_000);

  test('does not recover a legacy UUID-only file or render carry-over as complete', async () => {
    const chatId = String(Date.now() * 1_000 + 2);
    const threadId = randomUUID();
    const carryMarker = `legacycarry${randomUUID().replaceAll('-', '')}`;
    let legacyNativePath = '';

    await withIntegrationFixture(
      'codex-native-path-no-legacy-recovery',
      async (fixture) => {
        let failure: unknown;
        try {
          await fixture.client.getMessages(chatId);
        } catch (error) {
          failure = error;
        }

        expect(failure).toBeInstanceOf(GarconApiError);
        expect(failure).toMatchObject({
          status: 503,
          body: {
            success: false,
            errorCode: 'TRANSCRIPT_UNAVAILABLE',
            retryable: true,
          },
        });
        expect(await readNativeSession(fixture.dirs.workspace, chatId)).toEqual({
          agentSessionId: threadId,
        });
        expect(await readFile(legacyNativePath, 'utf8')).toContain(
          carryMarker.replace('carry', 'native'),
        );
      },
      {
        serverEnvironment: codexServerEnvironment(),
        async prepareWorkspace(directories) {
          const nativeMarker = carryMarker.replace('carry', 'native');
          legacyNativePath = await writeCodexTranscript({
            home: directories.home,
            projectPath: directories.project,
            threadId,
            userContent: nativeMarker,
            assistantContent: `legacy-answer-${nativeMarker}`,
            canonicalFileName: false,
          });
          await seedWorkspace({
            workspace: directories.workspace,
            chatId,
            threadId,
            nativePath: null,
            projectPath: directories.project,
            carryUser: carryMarker,
            carryAssistant: `legacy-answer-${carryMarker}`,
          });
        },
      },
    );
  }, 15_000);
});

function codexServerEnvironment(): Record<string, string> {
  return {
    GARCON_CODEX_CLI: fileURLToPath(
      new URL('../../support/fake-codex-app-server.ts', import.meta.url),
    ),
    PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  };
}

async function writeCodexTranscript(input: {
  home: string;
  projectPath: string;
  threadId: string;
  userContent: string;
  assistantContent: string;
  canonicalFileName?: boolean;
}): Promise<string> {
  const directory = join(input.home, '.codex', 'sessions', '2026', '07', '24');
  await mkdir(directory, { recursive: true });
  const fileName =
    input.canonicalFileName === false
      ? `${input.threadId}.jsonl`
      : createCodexRolloutFileName(input.threadId, new Date(timestamp));
  const nativePath = join(directory, fileName);
  await writeFile(
    nativePath,
    [
      JSON.stringify({
        timestamp,
        type: 'session_meta',
        payload: {
          id: input.threadId,
          timestamp,
          cwd: input.projectPath,
          originator: 'garcon',
          cli_version: '0.144.6',
          source: 'vscode',
          model_provider: 'openai',
          history_mode: 'legacy',
        },
      }),
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: input.userContent }],
        },
      }),
      JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: { type: 'user_message', message: input.userContent },
      }),
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: input.assistantContent }],
        },
      }),
      '',
    ].join('\n'),
  );
  return nativePath;
}

async function seedWorkspace(input: {
  workspace: string;
  chatId: string;
  threadId: string;
  nativePath: string | null;
  projectPath: string;
  carryUser: string;
  carryAssistant: string;
}): Promise<void> {
  await writeFile(
    join(input.workspace, 'workspace-version.json'),
    JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }),
  );
  await writeFile(
    join(input.workspace, 'chats.json'),
    JSON.stringify({
      version: 3,
      sessions: {
        [input.chatId]: {
          agentId: 'codex',
          nativeSession: {
            ownerId: 'codex',
            schemaVersion: 1,
            value: {
              ...(input.nativePath ? { path: input.nativePath } : {}),
              agentSessionId: input.threadId,
            },
          },
          agentOwnershipEpoch: randomUUID(),
          agentSettingsById: {},
          projectPath: input.projectPath,
          tags: [],
          agentSessionId: input.threadId,
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
    }),
  );
  await writeFile(
    join(input.workspace, 'chat-carryover.json'),
    JSON.stringify({
      version: 4,
      chats: {
        [input.chatId]: {
          revision: 1,
          segments: [
            {
              agentId: 'cursor',
              model: 'cursor-model',
              messages: [
                { type: 'user-message', timestamp, content: input.carryUser },
                {
                  type: 'assistant-message',
                  timestamp,
                  content: input.carryAssistant,
                },
              ],
              at: timestamp,
            },
          ],
        },
      },
    }),
  );
}

async function readNativeSession(
  workspace: string,
  chatId: string,
): Promise<{ path?: string; agentSessionId: string }> {
  const registry = JSON.parse(await readFile(join(workspace, 'chats.json'), 'utf8')) as {
    sessions: Record<
      string,
      {
        nativeSession: { value: { path?: string; agentSessionId: string } };
      }
    >;
  };
  return registry.sessions[chatId]!.nativeSession.value;
}

function messageLabels(messages: ChatMessage[]): string[] {
  return messages.map((message) => {
    if (message.type === 'user-message' || message.type === 'assistant-message') {
      return message.content;
    }
    return message.type;
  });
}
