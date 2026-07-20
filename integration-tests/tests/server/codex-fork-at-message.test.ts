import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('Codex fork at message', () => {
  test('preserves a selected prefix when suppressed native entries are filtered', async () => {
    const sourceChatId = String(Date.now() * 1_000 + 1);
    const sourceAgentSessionId = randomUUID();
    let sourceNativePath = '';

    await withIntegrationFixture('codex-fork-at-message', async (fixture) => {
      const source = await fixture.client.getMessages(sourceChatId);
      expect(source.messages.map((entry) => [entry.seq, entry.message.type])).toEqual([
        [1, 'user-message'],
        [2, 'assistant-message'],
      ]);

      const targetChatId = fixture.newChatId();
      const fork = await fixture.client.forkChat({
        sourceChatId,
        chatId: targetChatId,
        upToSeq: 2,
      });
      expect(fork.chat.id).toBe(targetChatId);

      const forked = await fixture.client.getMessages(targetChatId);
      expect(forked.messages.map((entry) => entry.message))
        .toEqual(source.messages.map((entry) => entry.message));

      const registry = JSON.parse(
        await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
      ) as {
        sessions: Record<string, { nativeSession: { value: { path: string } } }>;
      };
      const targetNativePath = registry.sessions[targetChatId]!.nativeSession.value.path;
      const targetLines = (await readFile(targetNativePath, 'utf8')).trimEnd().split('\n');
      expect(JSON.parse(targetLines[1]!)).toEqual({ type: 'garcon_fork_filtered' });
      expect(targetNativePath).not.toBe(sourceNativePath);
    }, {
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
        await mkdir(dirname(sourceNativePath), { recursive: true });
        const timestamp = '2026-07-20T00:00:00.000Z';
        await writeFile(sourceNativePath, [
          JSON.stringify({
            timestamp,
            type: 'session_meta',
            payload: { id: sourceAgentSessionId, cwd: directories.project },
          }),
          JSON.stringify({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'hello' }],
            },
          }),
          JSON.stringify({
            timestamp,
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello' },
          }),
          JSON.stringify({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'world' }],
            },
          }),
          '',
        ].join('\n'));
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
                value: {
                  path: sourceNativePath,
                  agentSessionId: sourceAgentSessionId,
                },
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
