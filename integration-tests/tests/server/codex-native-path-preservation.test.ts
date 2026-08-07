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
import { reloadUntilNativeContains } from '../../support/live-agent.js';

const timestamp = '2026-07-24T00:00:00.000Z';

describe('Codex native transcript path preservation', () => {
  test('keeps a new cross-agent fork attached to the same transcript across restarts', async () => {
    const sourceChatId = String(Date.now() * 1_000 + 1);
    const cursorMarker = `cursorcarry${randomUUID().replaceAll('-', '')}`;
    const codexMarker = `codexnative${randomUUID().replaceAll('-', '')}`;

    await withIntegrationFixture(
      'codex-native-path-preservation',
      async (fixture) => {
        const first = await fixture.client.startDirectChat({
          chatId: sourceChatId,
          content: cursorMarker,
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.openAi,
        });
        await fixture.client.waitForTurnTerminal(sourceChatId, first.turnId);

        const catalog = await fixture.client.listAgentCatalog();
        const codex = catalog.agents.find((agent) => agent.id === 'codex');
        if (!codex) throw new Error('Codex integration is missing from the agent catalog');
        const sourceBeforeHandoff = (await fixture.client.listChats()).sessions.find(
          (chat) => chat.id === sourceChatId,
        );
        if (!sourceBeforeHandoff) throw new Error('Source chat disappeared before handoff');

        const codexTurn = await fixture.client.runChat({
          clientRequestId: randomUUID(),
          clientMessageId: randomUUID(),
          chatId: sourceChatId,
          command: codexMarker,
          handoff: {
            expectedAgentOwnershipEpoch: sourceBeforeHandoff.agentOwnershipEpoch,
            target: {
              agentId: codex.id,
              model: codex.defaultModel,
              permissionMode: 'default',
              thinkingMode: 'none',
              agentSettings: codex.defaultSettings,
            },
          },
        });
        const codexTerminal = await fixture.client.waitForTurnTerminal(
          sourceChatId,
          codexTurn.turnId,
        );
        expect(codexTerminal.type).toBe('agent-run-finished');

        const sourceNativeSession = await waitForNativeSessionPath(
          fixture.dirs.workspace,
          sourceChatId,
        );
        await reloadUntilNativeContains(fixture, sourceChatId, codexMarker);
        const source = await fixture.client.getMessages(sourceChatId);
        expect(messageLabels(source.messages.map((entry) => entry.message))).toEqual([
          cursorMarker,
          `echo:${cursorMarker}`,
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
        expect(beforeRestartPath).not.toBe(sourceNativeSession.path);
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
      },
    );
  }, 30_000);

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
            error: 'Chat transcript is temporarily unavailable. Retry the request.',
            errorCode: 'TRANSCRIPT_UNAVAILABLE',
            retryable: true,
          },
        });

        const target = fixture.directAgents.openAi;
        const switchFailure = await captureApiError(fixture.client.handoffDirectChat({
          chatId,
          content: 'attempt handoff from unavailable history',
          agent: target,
        }));
        expect(switchFailure).toMatchObject({
          status: 422,
          body: {
            success: false,
            error: 'The source transcript is temporarily unavailable. Retry the handoff.',
            errorCode: 'SOURCE_TRANSCRIPT_UNAVAILABLE',
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

  test('starts with one discovery snapshot for many preserved pathless chats', async () => {
    const chatIds = Array.from(
      { length: 100 },
      (_, index) => String(Date.now() * 1_000 + 10_000 + index),
    );
    const serverEnvironment = codexServerEnvironment();
    let callLogPath = '';

    await withIntegrationFixture(
      'codex-native-path-startup-snapshot',
      async (fixture) => {
        expect(
          fixture.garcon.logs.filter((line) =>
            line.includes('preserving chat') && line.includes('unresolved native session')
          ),
        ).toEqual([]);
        expect(await readFile(callLogPath, 'utf8')).toBe('thread/list\n');

        const firstFailure = await captureApiError(fixture.client.getMessages(chatIds[0]!));
        expect(firstFailure).toMatchObject({
          status: 503,
          body: {
            errorCode: 'TRANSCRIPT_UNAVAILABLE',
            retryable: true,
          },
        });
        expect(await readFile(callLogPath, 'utf8')).toBe('thread/list\n');

        const retryFailure = await captureApiError(fixture.client.getMessages(chatIds[0]!));
        expect(retryFailure).toMatchObject({
          status: 503,
          body: {
            errorCode: 'TRANSCRIPT_UNAVAILABLE',
            retryable: true,
          },
        });
        expect(await readFile(callLogPath, 'utf8')).toBe('thread/list\nthread/list\n');
      },
      {
        serverEnvironment,
        async prepareWorkspace(directories) {
          callLogPath = join(directories.root, 'codex-calls.log');
          serverEnvironment.INTEGRATION_CODEX_CALL_LOG = callLogPath;
          await writeFile(callLogPath, '');
          await seedPathlessWorkspace({
            workspace: directories.workspace,
            chatIds,
            projectPath: directories.project,
          });
        },
      },
    );
  }, 15_000);

  test('distinguishes discovery errors and retries a later discovery miss', async () => {
    const chatId = String(Date.now() * 1_000 + 3);
    const threadId = randomUUID();
    const carryMarker = `retrycarry${randomUUID().replaceAll('-', '')}`;

    await withIntegrationFixture(
      'codex-native-path-discovery-retry',
      async (fixture) => {
        const discoveryModePath = join(
          fixture.dirs.home,
          '.codex',
          'integration-discovery-mode',
        );
        const providerFailure = await captureApiError(fixture.client.getMessages(chatId));
        expect(providerFailure).toMatchObject({
          status: 500,
          body: {
            success: false,
            error: 'Internal server error',
            errorCode: 'INTERNAL_ERROR',
            retryable: true,
          },
        });
        expect(JSON.stringify(providerFailure.body)).not.toContain('/home/private');

        await writeFile(discoveryModePath, 'miss');
        const cleanMiss = await captureApiError(fixture.client.getMessages(chatId));
        expect(cleanMiss).toMatchObject({
          status: 503,
          body: {
            success: false,
            error: 'Chat transcript is temporarily unavailable. Retry the request.',
            errorCode: 'TRANSCRIPT_UNAVAILABLE',
            retryable: true,
          },
        });

        const nativeMarker = carryMarker.replace('carry', 'native');
        await writeCodexTranscript({
          home: fixture.dirs.home,
          projectPath: fixture.dirs.project,
          threadId,
          userContent: nativeMarker,
          assistantContent: `retry-answer-${nativeMarker}`,
        });
        await writeFile(discoveryModePath, 'normal');

        const recovered = await fixture.client.getMessages(chatId);
        expect(messageLabels(recovered.messages.map((entry) => entry.message))).toEqual([
          nativeMarker,
          `retry-answer-${nativeMarker}`,
        ]);
      },
      {
        serverEnvironment: codexServerEnvironment({ discoveryControl: true }),
        async prepareWorkspace(directories) {
          await mkdir(join(directories.home, '.codex'), { recursive: true });
          await writeFile(
            join(directories.home, '.codex', 'integration-discovery-mode'),
            'error',
          );
          await seedWorkspace({
            workspace: directories.workspace,
            chatId,
            threadId,
            nativePath: null,
            projectPath: directories.project,
            carryUser: carryMarker,
            carryAssistant: `retry-answer-${carryMarker}`,
          });
        },
      },
    );
  }, 20_000);
});

function codexServerEnvironment(
  options: { discoveryControl?: boolean } = {},
): Record<string, string> {
  return {
    GARCON_CODEX_CLI: fileURLToPath(
      new URL('../../support/fake-codex-app-server.ts', import.meta.url),
    ),
    PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ...(options.discoveryControl ? { INTEGRATION_CODEX_DISCOVERY_CONTROL: '1' } : {}),
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
      version: 4,
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
          carryOverHeadId: null,
          nativeSeedReceipt: null,
          carryOverMigrationQuarantine: null,
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

async function seedPathlessWorkspace(input: {
  workspace: string;
  chatIds: readonly string[];
  projectPath: string;
}): Promise<void> {
  const firstChatId = input.chatIds[0];
  if (!firstChatId) throw new Error('Pathless startup fixture requires at least one chat');
  await seedWorkspace({
    workspace: input.workspace,
    chatId: firstChatId,
    threadId: randomUUID(),
    nativePath: null,
    projectPath: input.projectPath,
    carryUser: 'startup-carry',
    carryAssistant: 'startup-carry-answer',
  });

  const registryPath = join(input.workspace, 'chats.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
    sessions: Record<string, {
      agentOwnershipEpoch: string;
      agentSessionId: string;
      nativeSession: {
        ownerId: string;
        schemaVersion: number;
        value: { agentSessionId: string };
      };
    }>;
  };
  const template = registry.sessions[firstChatId];
  if (!template) throw new Error('Pathless startup fixture template is missing');

  for (const chatId of input.chatIds.slice(1)) {
    const agentSessionId = randomUUID();
    registry.sessions[chatId] = {
      ...template,
      agentOwnershipEpoch: randomUUID(),
      agentSessionId,
      nativeSession: {
        ...template.nativeSession,
        value: { agentSessionId },
      },
    };
  }
  await writeFile(registryPath, JSON.stringify(registry));
  await writeFile(
    join(input.workspace, 'chat-metadata.json'),
    JSON.stringify({
      version: 1,
      chats: Object.fromEntries(input.chatIds.map((chatId) => [
        chatId,
        {
          chatId,
          createdAt: timestamp,
          lastActivity: timestamp,
          lastMessage: 'startup-carry-answer',
          firstMessage: 'startup-carry',
          source: 'startup',
        },
      ])),
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

async function waitForNativeSessionPath(
  workspace: string,
  chatId: string,
  timeoutMs = 5_000,
): Promise<{ path: string; agentSessionId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const nativeSession = await readNativeSession(workspace, chatId);
      if (nativeSession.path) {
        return { ...nativeSession, path: nativeSession.path };
      }
    } catch {
      // Session creation persists asynchronously after the terminal provider event.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for chat ${chatId} to persist its native path`);
}

async function captureApiError(request: Promise<unknown>): Promise<GarconApiError> {
  try {
    await request;
  } catch (error) {
    if (error instanceof GarconApiError) return error;
    throw error;
  }
  throw new Error('Expected the request to fail');
}

function messageLabels(messages: ChatMessage[]): string[] {
  return messages.map((message) => {
    if (message.type === 'user-message' || message.type === 'assistant-message') {
      return message.content;
    }
    return message.type;
  });
}
