import { describe, expect, test } from 'bun:test';
import { appendFile, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT } from '../../../common/chat-snapshot.js';
import { AssistantMessage } from '../../../common/chat-types.js';
import type {
  GetSharedChatResponse,
  ShareChatResponse,
} from '../../../common/share-types.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
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
import { reloadFromNativeHistory } from '../../support/live-agent.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

const HELD_PROMPT = 'native-reload-held-turn';

interface ClaudeNativeSession {
  readonly agentSessionId: string;
  readonly path: string;
}

describe('native transcript reload', () => {
  test('warns about native drift and keeps queued entries intact while blocking reload', async () => {
    const environment: Record<string, string> = {};
    let releasePath = '';

    await withIntegrationFixture('native-drift-reload', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is missing from the agent catalog.');

      const chatId = fixture.newChatId();
      const initial = await fixture.client.startChat({
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
      const share = await fixture.client.post<ShareChatResponse>('/api/v1/chats/share', { chatId });
      const sharedBeforeReload = await fixture.client.get<GetSharedChatResponse>(
        `/api/v1/shared?token=${encodeURIComponent(share.shareToken)}&limit=100`,
      );
      expect(sharedBeforeReload.snapshot.origin).toEqual({
        transcriptViewId: beforeDrift.transcriptViewId,
        lastOrdinal: beforeDrift.lastOrdinal,
      });

      const native = await claudeNativeSession(fixture.dirs, chatId);
      const externalContent = `external-native-${crypto.randomUUID()}`;
      await appendFile(native.path, `${JSON.stringify({
        sessionId: native.agentSessionId,
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        cwd: fixture.dirs.project,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: externalContent }],
        },
      })}\n`, 'utf8');

      const driftCursor = fixture.client.markEvents();
      const servedWhileProbing = await fixture.client.getMessages(chatId);
      expect(servedWhileProbing.transcriptViewId).toBe(beforeDrift.transcriptViewId);
      expect(assistantContents(servedWhileProbing.messages)).not.toContain(externalContent);
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) =>
            entry.message.type === 'transcript-notice'
            && entry.message.action === 'reload-native-history'),
        'native drift notice publication',
        { afterIndex: driftCursor },
      );
      const drifted = await fixture.client.getMessages(chatId);
      expect(drifted.transcriptViewId).toBe(beforeDrift.transcriptViewId);
      expect(assistantContents(drifted.messages)).not.toContain(externalContent);
      expect(messagesOfType(drifted.messages, 'transcript-notice')).toEqual([
        expect.objectContaining({
          action: 'reload-native-history',
          content: expect.stringContaining('changed outside Garcon'),
        }),
      ]);
      expect(messagesOfType(
        (await fixture.client.getMessages(chatId)).messages,
        'transcript-notice',
      )).toHaveLength(1);

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
      const sharedAfterReload = await fixture.client.get<GetSharedChatResponse>(
        `/api/v1/shared?token=${encodeURIComponent(share.shareToken)}&limit=100`,
      );
      expect(sharedAfterReload).toEqual(sharedBeforeReload);
      expect(JSON.stringify(sharedAfterReload.snapshot.messages)).not.toContain(externalContent);
      await expect(fixture.client.subscribe(
        chatId,
        beforeDrift.transcriptViewId,
        beforeDrift.lastOrdinal,
      )).rejects.toMatchObject({
        response: {
          requestType: 'chat-subscribe',
          code: 'STALE_TRANSCRIPT_VIEW',
          retryable: false,
          chatId,
        },
      });

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
      expect(afterStaleSubmission.transcriptViewId).toBe(reloaded.transcriptViewId);
      expect(afterStaleSubmission.lastOrdinal).toBe(reloaded.lastOrdinal);
      expect(afterStaleSubmission.messages).toEqual(reloaded.messages);

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

  test('rejects a fixed-watermark replay continuation after native reload replaces its view', async () => {
    const environment: Record<string, string> = {};

    await withIntegrationFixture('native-reload-replay-fence', async (fixture) => {
      const claude = (await fixture.client.listAgentCatalog()).agents.find(
        (agent) => agent.id === 'claude',
      );
      if (!claude) throw new Error('Claude integration is missing from the agent catalog.');

      const chatId = fixture.newChatId();
      const initial = await fixture.client.startChat({
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
