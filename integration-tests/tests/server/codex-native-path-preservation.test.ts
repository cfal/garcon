import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '../../../common/chat-types.js';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { reloadUntilNativeContains } from '../../support/live-agent.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';

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
          fixture.dirs,
          sourceChatId,
        );
        await reloadUntilNativeContains(fixture, sourceChatId, codexMarker);
        const source = await fixture.client.getMessages(sourceChatId);
        // The handoff boundary closes the outgoing owner's history, so it sits between the
        // cursor exchange and the first Codex row.
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

});

function codexServerEnvironment(): Record<string, string> {
  return {
    GARCON_CODEX_CLI: fileURLToPath(
      new URL('../../support/fake-codex-app-server.ts', import.meta.url),
    ),
    INTEGRATION_CODEX_FORK_JSONL: '1',
    PATH: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  };
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
  directories: IntegrationDirectories,
  chatId: string,
  timeoutMs = 5_000,
): Promise<{ path: string; agentSessionId: string }> {
  return waitForPersistedChat({
    directories,
    chatId,
    timeoutMs,
    timeoutMessage: `Timed out waiting for chat ${chatId} to persist its native path`,
    select: (chat) => {
      const nativeSession = chat.nativeSession?.value;
      const nativePath = nativeSession?.path;
      const agentSessionId = nativeSession?.agentSessionId;
      return typeof nativePath === 'string'
        && nativePath.length > 0
        && typeof agentSessionId === 'string'
        && agentSessionId.length > 0
        ? { path: nativePath, agentSessionId }
        : null;
    },
  });
}

function messageLabels(messages: ChatMessage[]): string[] {
  return messages.map((message) => {
    if (message.type === 'user-message' || message.type === 'assistant-message') {
      return message.content;
    }
    return message.type;
  });
}
