import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { codexAgentSettings } from '../../support/live-codex.js';

const FIRST_PROMPT = 'pre-compaction prompt';
const FIRST_ANSWER = 'pre-compaction answer';
const SECOND_PROMPT = 'post-compaction prompt';
const SECOND_ANSWER = 'post-compaction answer';

// Codex compaction is append-only: the rollout keeps every row and records a
// contextCompaction marker rather than pruning history. The committed ledger
// preserves the complete conversation across the marker and a restart, and a
// point below the marker stays forkable because the provider still retains it.
describe('Codex compaction interleaving', () => {
  test('preserves the full ledger across an append-only compaction marker and restart', async () => {
    const chatId = String(Date.now() * 1_000 + 41);
    const agentSessionId = randomUUID();
    let nativePath = '';
    const serverEnvironment = {
      GARCON_CODEX_CLI: fileURLToPath(new URL(
        '../../support/fake-codex-app-server.ts',
        import.meta.url,
      )),
      PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      INTEGRATION_CODEX_FORK_JSONL: '1',
    };
    const timestamp = '2026-07-20T00:00:00.000Z';
    const turnRows = (turn: string, prompt: string, answer: string) => [
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          id: `${turn}-user`,
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
          internal_chat_message_metadata_passthrough: { turn_id: turn },
        },
      }),
      JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: { type: 'user_message', message: prompt },
      }),
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          id: `${turn}-answer`,
          role: 'assistant',
          content: [{ type: 'output_text', text: answer }],
          internal_chat_message_metadata_passthrough: { turn_id: turn },
        },
      }),
    ];
    const compactionMarker = JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: { type: 'context_compacted' },
    });

    await withIntegrationFixture('codex-compaction-interleaving', async (fixture) => {
      const rendered = (page: Awaited<ReturnType<typeof fixture.client.getMessages>>) =>
        page.messages.map((entry) => (
          'content' in entry.message ? entry.message.content : entry.message.type
        ));

      const before = await fixture.client.getMessages(chatId);
      expect(rendered(before)).toEqual([
        FIRST_PROMPT,
        FIRST_ANSWER,
        'compaction',
        SECOND_PROMPT,
        SECOND_ANSWER,
      ]);

      await fixture.restartGarcon();
      const after = await fixture.client.getMessages(chatId);
      expect(rendered(after)).toEqual(rendered(before));

      // A point in the retained pre-compaction turn stays forkable, since the
      // append-only rollout never dropped it.
      const forkId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId: chatId,
        chatId: forkId,
        agentSettings: codexAgentSettings(),
        transcriptViewId: after.transcriptViewId,
        upToOrdinal: after.messages[0]!.ordinal,
      });
      const forked = await fixture.client.getMessages(forkId);
      expect(rendered(forked)).toEqual([FIRST_PROMPT]);
    }, {
      serverEnvironment,
      async prepareWorkspace(directories) {
        nativePath = join(
          directories.home,
          '.codex',
          'sessions',
          '2026',
          '07',
          '20',
          `rollout-${agentSessionId}.jsonl`,
        );
        await mkdir(dirname(nativePath), { recursive: true });
        await writeFile(nativePath, `${[
          JSON.stringify({
            timestamp,
            type: 'session_meta',
            payload: {
              id: agentSessionId,
              timestamp,
              cwd: directories.project,
              originator: 'codex_cli_rs',
              cli_version: '0.144.6',
              source: 'cli',
              model_provider: 'openai',
              history_mode: 'legacy',
            },
          }),
          ...turnRows('turn-1', FIRST_PROMPT, FIRST_ANSWER),
          compactionMarker,
          ...turnRows('turn-2', SECOND_PROMPT, SECOND_ANSWER),
        ].join('\n')}\n`);
        await writeFile(
          join(directories.workspace, 'workspace-version.json'),
          JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }),
        );
        await writeFile(join(directories.workspace, 'chats.json'), JSON.stringify({
          version: 5,
          sessions: {
            [chatId]: {
              agentId: 'codex',
              nativeSession: {
                ownerId: 'codex',
                schemaVersion: 1,
                value: { path: nativePath, agentSessionId },
              },
              agentOwnershipEpoch: randomUUID(),
              agentSettingsById: {},
              projectPath: directories.project,
              tags: [],
              agentSessionId,
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
