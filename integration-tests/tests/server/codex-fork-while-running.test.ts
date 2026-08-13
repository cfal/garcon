import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const HISTORY_PROMPT = 'settled prompt';
const HISTORY_ANSWER = 'settled answer';
const RUNNING_PROMPT = 'running prompt';

describe('Codex fork while a turn is running', () => {
  test('forks ledger snapshots while native history trails and recovers after the turn', async () => {
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
      const running = await waitForMessages(fixture, sourceChatId, (messages) => (
        messages.some((entry) => entry.message.type === 'assistant-message'
          && entry.message.content === `codex-live2-${RUNNING_PROMPT}`)
      ));
      expect(running.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'assistant-message',
        'user-message',
        'thinking',
        'assistant-message',
        'assistant-message',
      ]);

      // Every streamed ledger point remains forkable through frozen carryover,
      // regardless of whether the native rollout has reached it.
      for (const sourcePoint of running.messages.slice(3)) {
        const targetChatId = fixture.newChatId();
        await fixture.client.forkChat({
          sourceChatId,
          chatId: targetChatId,
          transcriptViewId: running.transcriptViewId,
          upToOrdinal: sourcePoint.ordinal,
        });
        const forked = await fixture.client.getMessages(targetChatId);
        expect(forked.messages.map(semantic)).toEqual(
          running.messages.filter((entry) => entry.ordinal <= sourcePoint.ordinal).map(semantic),
        );
      }

      // Settled history is still forkable at a point while the agent works.
      const pointChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: pointChatId,
        transcriptViewId: settled.transcriptViewId,
        upToOrdinal: settled.messages[0]!.ordinal,
      });
      const pointForked = await fixture.client.getMessages(pointChatId);
      expect(pointForked.messages.map((entry) => entry.message))
        .toEqual(settled.messages.slice(0, 1).map((entry) => entry.message));

      // A whole-chat fork copies the transcript as it stands instead of refusing.
      const sourceAtWholeFork = await fixture.client.getMessages(sourceChatId);
      const wholeChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: wholeChatId });
      const wholeForked = await fixture.client.getMessages(wholeChatId);
      expect(wholeForked.messages.map(semantic)).toEqual(sourceAtWholeFork.messages.map(semantic));

      await writeFile(turnReleasePath, '');
      await fixture.client.waitForTurnTerminal(sourceChatId, run.turnId, { afterIndex: runCursor });
      await fixture.client.reloadChat(sourceChatId);

      // The same point is forkable once the rollout owns those messages.
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
      const selected = reloaded.messages[4]!;
      await fixture.client.forkChat({
        sourceChatId,
        chatId: recoveredChatId,
        transcriptViewId: reloaded.transcriptViewId,
        upToOrdinal: selected.ordinal,
      });
      const recovered = await fixture.client.getMessages(recoveredChatId);
      expect(recovered.messages.map(semantic))
        .toEqual(reloaded.messages.filter((entry) => entry.ordinal <= selected.ordinal).map(semantic));
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
  }, 30_000);
});

async function waitForMessages(
  fixture: Parameters<Parameters<typeof withIntegrationFixture>[1]>[0],
  chatId: string,
  predicate: (
    messages: Awaited<ReturnType<typeof fixture.client.getMessages>>['messages'],
  ) => boolean,
): Promise<Awaited<ReturnType<typeof fixture.client.getMessages>>> {
  const deadline = Date.now() + 10_000;
  let page = await fixture.client.getMessages(chatId);
  while (!predicate(page.messages) && Date.now() < deadline) {
    await Bun.sleep(100);
    page = await fixture.client.getMessages(chatId);
  }
  if (!predicate(page.messages)) throw new Error(`Chat ${chatId} did not reach the expected rows.`);
  return page;
}

function semantic(entry: { readonly message: { readonly type: string; readonly content?: unknown } }) {
  return [entry.message.type, entry.message.content ?? null];
}
