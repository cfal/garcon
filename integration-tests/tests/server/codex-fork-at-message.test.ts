import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import { CodexAppServerClient } from '../../../server-agents/codex/src/agents/codex/app-server/client.js';
import { buildThreadResumeParams } from '../../../server-agents/codex/src/agents/codex/app-server/request-builders.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('Codex fork at message', () => {
  test('preserves a resumable legacy prefix while decoding Code Mode Exec after reload', async () => {
    const sourceChatId = String(Date.now() * 1_000 + 1);
    const sourceAgentSessionId = randomUUID();
    let sourceNativePath = '';
    const serverEnvironment = {
      GARCON_CODEX_CLI: fileURLToPath(new URL(
        '../../support/fake-codex-app-server.ts',
        import.meta.url,
      )),
      PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      INTEGRATION_CODEX_DISCOVER_JSONL: '1',
    };

    await withIntegrationFixture('codex-fork-at-message', async (fixture) => {
      const source = await fixture.client.getMessages(sourceChatId);
      expect(source.messages.map((entry) => [entry.seq, entry.message.type])).toEqual([
        [1, 'user-message'],
        [2, 'exec-tool-use'],
        [3, 'bash-tool-use'],
        [4, 'tool-result'],
        [5, 'tool-result'],
        [6, 'assistant-message'],
      ]);

      const targetChatId = fixture.newChatId();
      const fork = await fixture.client.forkChat({
        sourceChatId,
        chatId: targetChatId,
        upToSeq: 6,
      });
      expect(fork.chat.id).toBe(targetChatId);

      const forked = await fixture.client.getMessages(targetChatId);
      expect(forked.messages.map((entry) => entry.message))
        .toEqual(source.messages.map((entry) => entry.message));

      const registry = JSON.parse(
        await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
      ) as {
        sessions: Record<string, {
          nativeSession: { value: { path: string; agentSessionId: string } };
        }>;
      };
      const targetNative = registry.sessions[targetChatId]!.nativeSession.value;
      const targetNativePath = targetNative.path;
      const targetLines = (await readFile(targetNativePath, 'utf8')).trimEnd().split('\n');
      expect(JSON.parse(targetLines[1]!)).toEqual({ type: 'garcon_fork_filtered' });
      expect(targetLines.some((line) => line.includes('"name":"exec"'))).toBe(true);
      expect(targetLines.some((line) => line.includes('"name":"wait"'))).toBe(true);
      expect(targetNativePath).not.toBe(sourceNativePath);

      const codex = new CodexAppServerClient({
        env: {
          HOME: fixture.dirs.home,
          CODEX_HOME: join(fixture.dirs.home, '.codex'),
        },
      });
      try {
        const resumed = await codex.resumeThread(buildThreadResumeParams({
          agentSessionId: targetNative.agentSessionId,
          nativePath: targetNativePath,
          model: 'gpt-5.6-sol',
          projectPath: fixture.dirs.project,
          permissionMode: 'default',
        }));
        expect(resumed.thread).toMatchObject({
          id: targetNative.agentSessionId,
          path: targetNativePath,
        });
      } finally {
        codex.shutdown();
      }

      await fixture.restartGarcon();
      const reloaded = await fixture.client.getMessages(targetChatId);
      expect(reloaded.messages.map((entry) => entry.message))
        .toEqual(source.messages.map((entry) => entry.message));
      expect(reloaded.messages.some((entry) => entry.message.type === 'exec-tool-use')).toBe(true);
      expect(reloaded.messages.some((entry) => entry.message.type === 'wait-tool-use')).toBe(false);
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
        await mkdir(dirname(sourceNativePath), { recursive: true });
        const timestamp = '2026-07-20T00:00:00.000Z';
        await writeFile(sourceNativePath, [
          JSON.stringify({
            timestamp,
            type: 'session_meta',
            payload: {
              id: sourceAgentSessionId,
              timestamp,
              cwd: directories.project,
              originator: 'codex_cli_rs',
              cli_version: '0.142.2',
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
              type: 'custom_tool_call',
              name: 'exec',
              call_id: 'outer-exec',
              input: 'text("sanitized fixture")',
            },
          }),
          JSON.stringify({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'exec_command',
              call_id: 'inner-command',
              arguments: JSON.stringify({ cmd: 'pwd', workdir: directories.project }),
            },
          }),
          JSON.stringify({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'inner-command',
              output: directories.project,
            },
          }),
          JSON.stringify({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'custom_tool_call_output',
              call_id: 'outer-exec',
              output: 'completed',
            },
          }),
          JSON.stringify({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'wait',
              call_id: 'outer-wait',
              arguments: JSON.stringify({ cell_id: 'sanitized-cell', yield_time_ms: 100 }),
            },
          }),
          JSON.stringify({
            timestamp,
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'outer-wait',
              output: 'completed',
            },
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
