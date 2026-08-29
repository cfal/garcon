import { describe, expect, test } from 'bun:test';
import { appendFile, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT } from '../../../common/chat-snapshot.js';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import { AssistantMessage } from '../../../common/chat-types.js';
import type {
  GetSharedChatResponse,
  ShareChatResponse,
} from '../../../common/share-types.js';
import type { ChatOperationalNoticeMessage } from '../../../common/ws-events.js';
import { NATIVE_TRANSCRIPT_DRIFT_NOTICE } from '../../../server/ledger/native-activity.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import { GarconApiError, GarconWsRequestError } from '../../support/garcon-client.js';
import {
  type IntegrationDirectories,
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  reloadFromNativeHistory,
  reloadUntilNativeContains,
} from '../../support/live-agent.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

const HELD_PROMPT = 'native-reload-held-turn';

interface ClaudeNativeSession {
  readonly agentSessionId: string;
  readonly path: string;
}

describe('native transcript reload', () => {
  test('[TLV5-L08.04-SERVER-01] [TLV5-L09.05-SERVER-01] keeps drift transient until explicit native Reload', async () => {
    const environment: Record<string, string> = {};
    let releasePath = '';

    await withIntegrationFixture('native-drift-reload', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is missing from the agent catalog.');
      await fixture.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });

      const chatId = fixture.newChatId();
      const initial = await fixture.client.startChat({
        origin: 'interactive',
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        agentId: claude.id,
        projectPath: fixture.dirs.project,
        model: claude.defaultModel,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: claude.defaultSettings,
        command: 'native-reload-baseline',
      });
      await fixture.client.waitForTurnTerminal(chatId, initial.turnId);

      const held = await fixture.client.runChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        command: HELD_PROMPT,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: claude.defaultSettings,
        model: claude.defaultModel,
      });
      await waitForAssistantContent(fixture, chatId, `echo:${HELD_PROMPT}`);
      await fixture.client.enqueueNew(chatId, 'queued-before-reload');
      const paused = await fixture.client.pauseQueue(chatId);
      expect(paused.control.queue.entries.map((entry) => entry.content)).toEqual([
        'queued-before-reload',
      ]);
      expect(paused.control.queue.pause?.kind).toBe('manual');

      await writeFile(releasePath, 'release');
      await fixture.client.waitForTurnTerminal(chatId, held.turnId);
      const beforeDrift = await fixture.client.getMessages(chatId);
      expect(messagesOfType(beforeDrift.messages, 'transcript-notice')).toEqual([]);
      const searchRequest = {
        query: 'native-reload-baseline',
        chatIds: [chatId],
        limit: 20,
      };
      const searchBeforeDrift = await fixture.client.waitForChatSearch(
        searchRequest,
        (response) => response.index.pendingChatCount === 0
          && response.results.some((result) => result.chatId === chatId),
      );
      const share = await fixture.client.post<ShareChatResponse>('/api/v1/chats/share', { chatId });
      const sharedBeforeReload = await fixture.client.get<GetSharedChatResponse>(
        `/api/v1/shared?token=${encodeURIComponent(share.shareToken)}&limit=100`,
      );
      expect(sharedBeforeReload.snapshot.origin).toEqual({
        transcriptViewId: beforeDrift.transcriptViewId,
        lastOrdinal: beforeDrift.lastOrdinal,
      });

      const native = await claudeNativeSession(fixture.dirs, chatId);
      const externalContent = 'synthetic-external-native-output';
      await appendFile(native.path, `${JSON.stringify({
        sessionId: native.agentSessionId,
        type: 'assistant',
        uuid: '00000000-0000-4000-8000-000000000001',
        timestamp: '2099-01-01T00:00:00.000Z',
        cwd: fixture.dirs.project,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: externalContent }],
        },
      })}\n`, 'utf8');

      const driftCursor = fixture.client.markEvents();
      const servedWhileProbing = await fixture.client.getMessages(chatId, {
        purpose: 'activation',
      });
      expect(servedWhileProbing.transcriptViewId).toBe(beforeDrift.transcriptViewId);
      expect(assistantContents(servedWhileProbing.messages)).not.toContain(externalContent);
      await fixture.client.waitForEvent(
        (event): event is ChatOperationalNoticeMessage =>
          event.type === 'chat-operational-notice'
          && event.chatId === chatId
          && event.noticeType === 'warning'
          && event.content === NATIVE_TRANSCRIPT_DRIFT_NOTICE,
        'native drift notice publication',
        { afterIndex: driftCursor },
      );
      const drifted = await fixture.client.getMessages(chatId);
      expect(drifted).toMatchObject({
        transcriptViewId: beforeDrift.transcriptViewId,
        lastOrdinal: beforeDrift.lastOrdinal,
        messages: beforeDrift.messages,
      });
      expect(assistantContents(drifted.messages)).not.toContain(externalContent);
      expect(messagesOfType(drifted.messages, 'transcript-notice')).toEqual([]);
      expect(await fixture.client.searchChats(searchRequest)).toEqual(searchBeforeDrift);
      const externalSearch = await fixture.client.searchChats({
        query: externalContent,
        chatIds: [chatId],
        limit: 20,
      });
      expect(externalSearch.index.pendingChatCount).toBe(0);
      expect(externalSearch.results).toEqual([]);

      const repeatedDriftCursor = fixture.client.markEvents();
      await fixture.client.getMessages(chatId, { purpose: 'activation' });
      await fixture.client.waitForEvent(
        (event): event is ChatOperationalNoticeMessage =>
          event.type === 'chat-operational-notice'
          && event.chatId === chatId
          && event.noticeType === 'warning'
          && event.content === NATIVE_TRANSCRIPT_DRIFT_NOTICE,
        'repeated native drift notice publication',
        { afterIndex: repeatedDriftCursor },
      );
      expect(await fixture.client.getMessages(chatId)).toMatchObject({
        transcriptViewId: beforeDrift.transcriptViewId,
        lastOrdinal: beforeDrift.lastOrdinal,
        messages: beforeDrift.messages,
      });

      let blockedReload: unknown;
      try {
        await fixture.client.reloadChat(chatId);
      } catch (error) {
        blockedReload = error;
      }
      expect(blockedReload).toBeInstanceOf(GarconWsRequestError);
      expect(blockedReload).toMatchObject({
        response: {
          requestType: 'chat-reload',
          code: 'CHAT_RUNNING',
          retryable: false,
          chatId,
        },
      });
      const blockedControl = await fixture.client.getExecutionControl(chatId);
      expect(blockedControl.queue.entries.map((entry) => entry.content)).toEqual([
        'queued-before-reload',
      ]);
      expect((await fixture.client.getMessages(chatId)).transcriptViewId)
        .toBe(beforeDrift.transcriptViewId);

      await fixture.client.clearQueue(chatId);
      await reloadFromNativeHistory(fixture, chatId);
      const reloaded = await fixture.client.getMessages(chatId);
      expect(reloaded.transcriptViewId).not.toBe(beforeDrift.transcriptViewId);
      expect(userContents(reloaded.messages)).toEqual([
        'native-reload-baseline',
        HELD_PROMPT,
      ]);
      expect(assistantContents(reloaded.messages)).toEqual([
        'echo:native-reload-baseline',
        `echo:${HELD_PROMPT}`,
        externalContent,
      ]);
      expect(messagesOfType(reloaded.messages, 'transcript-notice')).toEqual([]);

      await reloadFromNativeHistory(fixture, chatId);
      const reloadedAgain = await fixture.client.getMessages(chatId);
      expect(reloadedAgain.transcriptViewId).not.toBe(reloaded.transcriptViewId);
      expect(reloadedAgain.messages).toEqual(reloaded.messages);
      expect(userContents(reloadedAgain.messages)).toEqual([
        'native-reload-baseline',
        HELD_PROMPT,
      ]);
      expect(assistantContents(reloadedAgain.messages)).toEqual([
        'echo:native-reload-baseline',
        `echo:${HELD_PROMPT}`,
        externalContent,
      ]);
      const sharedAfterReload = await fixture.client.get<GetSharedChatResponse>(
        `/api/v1/shared?token=${encodeURIComponent(share.shareToken)}&limit=100`,
      );
      expect(sharedAfterReload).toEqual(sharedBeforeReload);
      expect(JSON.stringify(sharedAfterReload.snapshot.messages)).not.toContain(externalContent);
      for (const replaced of [beforeDrift, reloaded]) {
        await expect(fixture.client.subscribe(
          chatId,
          replaced.transcriptViewId,
          replaced.lastOrdinal,
        )).rejects.toMatchObject({
          response: {
            requestType: 'chat-subscribe',
            code: 'STALE_TRANSCRIPT_VIEW',
            retryable: false,
            chatId,
          },
        });
      }

      let staleSubmission: unknown;
      try {
        await fixture.client.runChat({
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          chatId,
          transcriptViewId: beforeDrift.transcriptViewId,
          command: 'stale-after-native-reload',
          permissionMode: 'default',
          thinkingMode: 'none',
          agentSettings: claude.defaultSettings,
          model: claude.defaultModel,
        });
      } catch (error) {
        staleSubmission = error;
      }
      expect(staleSubmission).toBeInstanceOf(GarconApiError);
      expect(staleSubmission).toMatchObject({
        status: 409,
        body: {
          errorCode: 'STALE_TRANSCRIPT_VIEW',
          retryable: false,
        },
      });
      const afterStaleSubmission = await fixture.client.getMessages(chatId);
      expect(afterStaleSubmission.transcriptViewId).toBe(reloadedAgain.transcriptViewId);
      expect(afterStaleSubmission.lastOrdinal).toBe(reloadedAgain.lastOrdinal);
      expect(afterStaleSubmission.messages).toEqual(reloadedAgain.messages);

      const resumed = await fixture.client.runChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        command: 'after-native-reload',
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: claude.defaultSettings,
        model: claude.defaultModel,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, resumed.turnId)).type)
        .toBe('agent-run-finished');
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toContain(
        'echo:after-native-reload',
      );
    }, {
      serverEnvironment: environment,
      async prepareWorkspace(directories) {
        const fakeModule = fileURLToPath(
          new URL('../../support/fake-claude-cli.ts', import.meta.url),
        );
        const binaryPath = join(directories.root, 'claude');
        releasePath = join(directories.root, 'claude-release');
        await writeFile(
          binaryPath,
          `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fakeModule).href)};\n`,
        );
        await chmod(binaryPath, 0o755);
        environment.CLAUDE_BINARY = binaryPath;
        environment.CLAUDE_CONFIG_DIR = join(directories.home, '.claude-integration');
        environment.ANTHROPIC_API_KEY = 'integration-fake-claude-key';
        environment.CLAUDE_TEST_RELEASE_PATH = releasePath;
        environment.CLAUDE_TEST_STREAM_PROMPT = HELD_PROMPT;
      },
    });
  }, 30_000);

  test('[TLV5-L08.03-SERVER-01] rejects a fixed-watermark replay continuation after native reload replaces its view', async () => {
    const environment: Record<string, string> = {};

    await withIntegrationFixture('native-reload-replay-fence', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is missing from the agent catalog.');

      const chatId = fixture.newChatId();
      const initial = await fixture.client.startChat({
        origin: 'interactive',
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        agentId: claude.id,
        projectPath: fixture.dirs.project,
        model: claude.defaultModel,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: claude.defaultSettings,
        command: 'native-reload-replay-baseline',
      });
      await fixture.client.waitForTurnTerminal(chatId, initial.turnId);
      const beforeInjection = await fixture.client.getMessages(chatId);

      await fixture.restartGarcon({
        beforeStart: async () => {
          const store = new TranscriptLedgerStore(
            join(fixture.dirs.workspace, 'transcript-ledgers'),
          );
          try {
            const view = store.currentView(chatId);
            if (view?.viewId !== beforeInjection.transcriptViewId) {
              throw new Error('The replay fixture opened a different transcript view.');
            }
            store.append(
              chatId,
              view.viewId,
              Array.from({ length: CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT + 20 }, (_, index) => ({
                kind: 'provider-row' as const,
                at: new Date(Date.UTC(2026, 7, 15, 0, 0, index)).toISOString(),
                message: new AssistantMessage(
                  new Date(Date.UTC(2026, 7, 15, 0, 0, index)).toISOString(),
                  `old-view-replay-${index}`,
                ),
                providerMeta: null,
              })),
            );
          } finally {
            store.close();
          }
        },
      });

      const firstPage = await fixture.client.subscribe(
        chatId,
        beforeInjection.transcriptViewId,
        0,
      );
      expect(firstPage).toMatchObject({
        transcriptViewId: beforeInjection.transcriptViewId,
        hasMore: true,
      });
      const replay = firstPage as typeof firstPage & {
        readonly nextAfterOrdinal: number;
        readonly throughOrdinal: number;
      };
      expect(replay.nextAfterOrdinal).toBeGreaterThan(0);
      expect(replay.nextAfterOrdinal).toBeLessThan(replay.throughOrdinal);

      await reloadFromNativeHistory(fixture, chatId);
      const reloaded = await fixture.client.getMessages(chatId);
      expect(reloaded.transcriptViewId).not.toBe(beforeInjection.transcriptViewId);
      await expect(fixture.client.subscribe(
        chatId,
        beforeInjection.transcriptViewId,
        replay.nextAfterOrdinal,
        replay.throughOrdinal,
      )).rejects.toMatchObject({
        response: {
          requestType: 'chat-subscribe',
          code: 'STALE_TRANSCRIPT_VIEW',
          retryable: false,
          chatId,
        },
      });
      expect(JSON.stringify((await fixture.client.getMessages(chatId)).messages))
        .not.toContain('old-view-replay-');
    }, {
      serverEnvironment: environment,
      async prepareWorkspace(directories) {
        const fakeModule = fileURLToPath(
          new URL('../../support/fake-claude-cli.ts', import.meta.url),
        );
        const binaryPath = join(directories.root, 'claude');
        await writeFile(
          binaryPath,
          `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fakeModule).href)};\n`,
        );
        await chmod(binaryPath, 0o755);
        environment.CLAUDE_BINARY = binaryPath;
        environment.CLAUDE_CONFIG_DIR = join(directories.home, '.claude-integration');
        environment.ANTHROPIC_API_KEY = 'integration-fake-claude-key';
      },
    });
  }, 30_000);

  test('[TLV5-A13-SERVER-HANDOFF-01] never imports old-owner native activity after handoff', async () => {
    const environment: Record<string, string> = {};
    const sourcePrompt = `frozen-source-${crypto.randomUUID()}`;
    const directPrompt = `middle-owner-${crypto.randomUUID()}`;
    const currentPrompt = `current-source-${crypto.randomUUID()}`;
    const staleSourceReply = `stale-source-${crypto.randomUUID()}`;

    await withIntegrationFixture('native-activity-after-handoff', async (fixture) => {
      const catalog = await fixture.client.listAgentCatalog();
      const claude = catalog.agents.find((agent) => agent.id === 'claude');
      if (!claude) throw new Error('Claude integration is required for handoff isolation.');

      const chatId = fixture.newChatId();
      const source = await fixture.client.startChat({
        origin: 'interactive',
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        agentId: claude.id,
        projectPath: fixture.dirs.project,
        model: claude.defaultModel,
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: claude.defaultSettings,
        command: sourcePrompt,
      });
      await fixture.client.waitForTurnTerminal(chatId, source.turnId);
      const sourceNative = await claudeNativeSession(fixture.dirs, chatId);
      const sourceChat = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === chatId,
      );
      if (!sourceChat) throw new Error('Source chat disappeared before handoff.');

      const direct = await fixture.client.handoffDirectChat({
        chatId,
        content: directPrompt,
        agent: fixture.directAgents.openAi,
        expectedAgentOwnershipEpoch: sourceChat.agentOwnershipEpoch,
      });
      await fixture.client.waitForTurnTerminal(chatId, direct.turnId);
      const directReply = assistantContents(
        (await fixture.client.getMessages(chatId)).messages,
      ).at(-1);
      if (!directReply?.includes(directPrompt)) {
        throw new Error('Direct session did not render its handoff reply.');
      }

      await appendFile(sourceNative.path, `${JSON.stringify({
        sessionId: sourceNative.agentSessionId,
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        cwd: fixture.dirs.project,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: staleSourceReply }],
        },
      })}\n`, 'utf8');

      const directChat = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === chatId,
      );
      if (!directChat) throw new Error('Direct chat disappeared before returning to Claude.');
      const current = await fixture.client.runChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        command: currentPrompt,
        handoff: {
          expectedAgentOwnershipEpoch: directChat.agentOwnershipEpoch,
          target: {
            agentId: claude.id,
            model: claude.defaultModel,
            permissionMode: 'default',
            thinkingMode: 'none',
            agentSettings: claude.defaultSettings,
          },
        },
      });
      await fixture.client.waitForTurnTerminal(chatId, current.turnId);
      const currentNative = await claudeNativeSession(fixture.dirs, chatId);
      expect(currentNative.path).not.toBe(sourceNative.path);
      const live = await fixture.client.getMessages(chatId);
      const currentReply = assistantContents(live.messages).at(-1);
      if (!currentReply?.includes(currentPrompt)) {
        throw new Error('Current Claude session did not render its handoff reply.');
      }
      await reloadUntilNativeContains(fixture, chatId, currentPrompt);
      const settled = await fixture.client.getMessages(chatId);
      const settledRows = conversationRows(settled.messages);
      expect(settledRows).toEqual([
        { type: 'user-message', content: sourcePrompt },
        { type: 'assistant-message', content: `echo:${sourcePrompt}` },
        { type: 'agent-switch', content: null },
        { type: 'user-message', content: directPrompt },
        { type: 'assistant-message', content: directReply },
        { type: 'agent-switch', content: null },
        { type: 'user-message', content: currentPrompt },
        { type: 'assistant-message', content: currentReply },
      ]);

      await reloadFromNativeHistory(fixture, chatId);
      const reloaded = await fixture.client.getMessages(chatId);
      expect(reloaded.transcriptViewId).not.toBe(settled.transcriptViewId);
      expect(conversationRows(reloaded.messages)).toEqual(settledRows);
      expect(assistantContents(reloaded.messages)).not.toContain(staleSourceReply);
      expect(messagesOfType(reloaded.messages, 'agent-switch')).toHaveLength(2);
    }, {
      serverEnvironment: environment,
      async prepareWorkspace(directories) {
        const fakeModule = fileURLToPath(
          new URL('../../support/fake-claude-cli.ts', import.meta.url),
        );
        const binaryPath = join(directories.root, 'claude');
        await writeFile(
          binaryPath,
          `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fakeModule).href)};\n`,
        );
        await chmod(binaryPath, 0o755);
        environment.CLAUDE_BINARY = binaryPath;
        environment.CLAUDE_CONFIG_DIR = join(directories.home, '.claude-integration');
        environment.ANTHROPIC_API_KEY = 'integration-fake-claude-key';
      },
    });
  }, 120_000);
});

async function claudeNativeSession(
  directories: IntegrationDirectories,
  chatId: string,
): Promise<ClaudeNativeSession> {
  const chat = await waitForPersistedNativeSession({
    directories,
    chatId,
    agentId: 'claude',
  });
  const agentSessionId = typeof chat.agentSessionId === 'string' ? chat.agentSessionId : '';
  const nativeSession = chat.nativeSession && typeof chat.nativeSession === 'object'
    ? chat.nativeSession as Record<string, unknown>
    : null;
  const value = nativeSession?.value && typeof nativeSession.value === 'object'
    ? nativeSession.value as Record<string, unknown>
    : null;
  const path = typeof value?.path === 'string' ? value.path : '';
  if (!agentSessionId || !path) {
    throw new Error(`Claude chat ${chatId} has no persisted native transcript.`);
  }
  return { agentSessionId, path };
}

async function waitForAssistantContent(
  fixture: IntegrationFixture,
  chatId: string,
  content: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = await fixture.client.getMessages(chatId);
    if (assistantContents(page.messages).includes(content)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Chat ${chatId} never rendered assistant content ${content}.`);
}

function conversationRows(messages: readonly TranscriptMessage[]) {
  return messages.map(({ message }) => ({
    type: message.type,
    content: 'content' in message ? message.content : null,
  }));
}
