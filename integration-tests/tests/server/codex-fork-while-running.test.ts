import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import { GarconApiError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const HISTORY_PROMPT = 'settled prompt';
const HISTORY_ANSWER = 'settled answer';
const RUNNING_PROMPT = 'running prompt';

describe('Codex fork while a turn is running', () => {
  test('forks settled history, refuses event-stream points, and recovers after the turn', async () => {
    const sourceChatId = String(Date.now() * 1_000 + 1);
    const sourceAgentSessionId = randomUUID();
    let sourceNativePath = '';
    let turnReleasePath = '';
    const serverEnvironment = {
      GARCON_CODEX_CLI: fileURLToPath(new URL(
        '../../support/fake-codex-app-server.ts',
        import.meta.url,
      )),
      PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      INTEGRATION_CODEX_FORK_JSONL: '1',
      INTEGRATION_CODEX_STREAMING_TURN: '1',
      INTEGRATION_CODEX_TURN_RELEASE: '',
    };

    await withIntegrationFixture('codex-fork-while-running', async (fixture) => {
      const settled = await fixture.client.getMessages(sourceChatId);
      expect(settled.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'assistant-message',
      ]);

      const catalog = await fixture.client.listAgentCatalog();
      const codex = catalog.agents.find((agent) => agent.id === 'codex');
      if (!codex) throw new Error('Codex integration is missing from the agent catalog');
      expect(codex.supportsForkWhileRunning).toBe(true);

      const runCursor = fixture.client.markEvents();
      const run = await fixture.client.runChat({
        chatId: sourceChatId,
        clientRequestId: randomUUID(),
        clientMessageId: randomUUID(),
        command: RUNNING_PROMPT,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: codex.defaultSettings,
        model: codex.defaultModel,
      });
      // Both streamed answers land above the persisted history, so the view outruns the rollout.
      const running = await waitForLastSeq(fixture, sourceChatId, 5);
      expect(running.messages.map((entry) => [entry.seq, entry.message.type])).toEqual([
        [1, 'user-message'],
        [2, 'assistant-message'],
        [3, 'user-message'],
        [4, 'assistant-message'],
        [5, 'assistant-message'],
      ]);

      // Seq 4 and 5 exist only on the event stream. Seq 4 additionally sits inside the range the
      // rollout has already grown into, which is what used to fork at the wrong message.
      for (const upToSeq of [4, 5]) {
        await expectEventStreamForkRefusal(fixture.client.forkChat({
          sourceChatId,
          chatId: fixture.newChatId(),
          upToSeq,
        }));
      }

      // Settled history is still forkable at a point while the agent works.
      const pointChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: pointChatId, upToSeq: 1 });
      const pointForked = await fixture.client.getMessages(pointChatId);
      expect(pointForked.messages.map((entry) => entry.message))
        .toEqual(settled.messages.slice(0, 1).map((entry) => entry.message));

      // A whole-chat fork copies the transcript as it stands instead of refusing.
      const wholeChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: wholeChatId });
      const wholeForked = await fixture.client.getMessages(wholeChatId);
      expect(wholeForked.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'assistant-message',
        'user-message',
        'thinking',
      ]);

      await writeFile(turnReleasePath, '');
      await fixture.client.waitForTurnTerminal(sourceChatId, run.turnId, { afterIndex: runCursor });
      await fixture.client.reloadChat(sourceChatId);

      // The same point is forkable once the rollout owns those messages.
      const settledSeq = 5;
      const reloaded = await fixture.client.getMessages(sourceChatId);
      expect(reloaded.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'assistant-message',
        'user-message',
        'thinking',
        'assistant-message',
        'assistant-message',
      ]);

      const recoveredChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: recoveredChatId,
        upToSeq: settledSeq,
      });
      const recovered = await fixture.client.getMessages(recoveredChatId);
      expect(recovered.messages.map((entry) => entry.message))
        .toEqual(reloaded.messages.slice(0, settledSeq).map((entry) => entry.message));
    }, {
      serverEnvironment,
      async prepareWorkspace(directories) {
        turnReleasePath = join(directories.root, 'codex-turn-release');
        serverEnvironment.INTEGRATION_CODEX_TURN_RELEASE = turnReleasePath;
        sourceNativePath = join(
          directories.home,
          '.codex',
          'sessions',
          '2026',
          '07',
          '20',
          `rollout-${sourceAgentSessionId}.jsonl`,
        );
        await mkdir(dirname(sourceNativePath), { recursive: true });
        const timestamp = '2026-07-20T00:00:00.000Z';
        await writeFile(sourceNativePath, `${[
          JSON.stringify({
            timestamp,
            type: 'session_meta',
            payload: {
              id: sourceAgentSessionId,
              timestamp,
              cwd: directories.project,
              originator: 'codex_cli_rs',
              cli_version: '0.144.6',
              source: 'cli',
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
              content: [{ type: 'input_text', text: HISTORY_PROMPT }],
            },
          }),
          JSON.stringify({
            timestamp,
            type: 'event_msg',
            payload: { type: 'user_message', message: HISTORY_PROMPT },
          }),
          JSON.stringify({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: HISTORY_ANSWER }],
            },
          }),
        ].join('\n')}\n`);
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
  }, 30_000);
});

async function waitForLastSeq(
  fixture: Parameters<Parameters<typeof withIntegrationFixture>[1]>[0],
  chatId: string,
  lastSeq: number,
): Promise<Awaited<ReturnType<typeof fixture.client.getMessages>>> {
  const deadline = Date.now() + 10_000;
  let page = await fixture.client.getMessages(chatId);
  while (page.lastSeq < lastSeq && Date.now() < deadline) {
    await Bun.sleep(1_000);
    page = await fixture.client.getMessages(chatId);
  }
  if (page.lastSeq !== lastSeq) {
    throw new Error(`Expected chat ${chatId} to reach seq ${lastSeq}, saw ${page.lastSeq}`);
  }
  return page;
}

async function expectEventStreamForkRefusal(promise: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(GarconApiError);
  expect(failure).toMatchObject({
    status: 409,
    body: {
      success: false,
      errorCode: 'MESSAGE_NOT_IN_NATIVE_HISTORY',
      retryable: true,
    },
  });
}
