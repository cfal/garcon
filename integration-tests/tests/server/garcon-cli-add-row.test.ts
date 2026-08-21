import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-add-row';

interface AddRowCliResult {
  readonly chatId: string;
  readonly ordinal: number;
  readonly status: 'appended' | 'duplicate';
  readonly transcriptViewId: string;
  readonly type: 'notice' | 'error';
}

async function runAddRow(
  fixture: IntegrationFixture,
  chatId: string,
  type: 'notice' | 'error',
  title: string,
  content: string,
): Promise<AddRowCliResult> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'cli/main.ts',
      '--config-dir', fixture.dirs.config,
      '--workspace', WORKSPACE,
      '--server', fixture.garcon.baseUrl,
      'add-row', chatId,
      '--type', type,
      '--title', title,
      content,
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARCON_CONFIG_DIR: '',
      GARCON_WORKSPACE: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  expect(stdout).not.toContain(content);
  expect(stdout).not.toContain(title);
  const match = stdout.match(
    /^chat id: (\d{16})\ntranscript view id: ([^\n]+)\nordinal: (\d+)\ntype: (notice|error)\nstatus: (appended|duplicate)\n$/,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) {
    throw new Error(`Unexpected add-row output: ${JSON.stringify(stdout)}`);
  }
  return {
    chatId: match[1],
    transcriptViewId: match[2],
    ordinal: Number(match[3]),
    type: match[4] as AddRowCliResult['type'],
    status: match[5] as AddRowCliResult['status'],
  };
}

function contentOf(message: ChatMessage): string | null {
  return 'content' in message && typeof message.content === 'string'
    ? message.content
    : null;
}

function detailOf(message: ChatMessage): unknown {
  return 'detail' in message ? message.detail : undefined;
}

function titleOf(message: ChatMessage): string | undefined {
  return 'title' in message && typeof message.title === 'string'
    ? message.title
    : undefined;
}

describe('garcon-cli add-row', () => {
  test('[TLV5-CHAT-ROW.05-SERVER-01] persists presentation-only rows without creating agent work', async () => {
    await withIntegrationFixture('garcon-cli-add-row', async (fixture) => {
      const searchSettings = await fixture.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });
      expect(searchSettings.settings.features.transcriptSearch.enabled).toBe(true);

      const chatId = fixture.newChatId();
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'chat-row-server-seed',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
        'agent-run-finished',
      );
      const initial = await fixture.client.getMessages(chatId, { limit: 200 });

      const held = fixture.fakeProviders.openAi.holdNext({
        lastUserText: 'chat-row-held-turn',
      });
      const processingCursor = fixture.client.markEvents();
      const heldTurn = await fixture.client.runDirectChat({
        chatId,
        content: 'chat-row-held-turn',
        agent: fixture.directAgents.openAi,
      });
      const heldRequest = await held.received;
      held.allowAbort();
      await fixture.client.waitForProcessing(chatId, true, { afterIndex: processingCursor });
      await fixture.client.ping();
      const eventCursor = fixture.client.markEvents();
      const controlBefore = await fixture.client.getExecutionControl(chatId);
      const providerRequestCount = fixture.fakeProviders.openAi.requests().length;

      const noticeContent = 'chatrownoticevisible user-only checkpoint';
      const errorContent = 'chatrowerrorvisible user-only checkpoint';
      const noticeTitle = 'chatrownoticetitlevisible Deployment';
      const errorTitle = 'chatrowerrortitlevisible Release validation';
      const notice = await runAddRow(fixture, chatId, 'notice', noticeTitle, noticeContent);
      const error = await runAddRow(fixture, chatId, 'error', errorTitle, errorContent);
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) => contentOf(entry.message) === errorContent),
        'the error chat row broadcast',
        { afterIndex: eventCursor },
      );

      expect(notice).toEqual({
        chatId,
        transcriptViewId: initial.transcriptViewId,
        ordinal: notice.ordinal,
        type: 'notice',
        status: 'appended',
      });
      expect(error).toEqual({
        chatId,
        transcriptViewId: initial.transcriptViewId,
        ordinal: notice.ordinal + 1,
        type: 'error',
        status: 'appended',
      });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(providerRequestCount);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(controlBefore);
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({ isProcessing: true });

      const chatRowEvents = fixture.client.eventsSince(eventCursor).flatMap((event) => (
        event.type === 'chat-messages' && event.chatId === chatId
          ? event.messages.filter((entry) => (
              entry.ordinal === notice.ordinal || entry.ordinal === error.ordinal
            ))
          : []
      ));
      expect(chatRowEvents.map((entry) => ({
        ordinal: entry.ordinal,
        type: entry.message.type,
        content: contentOf(entry.message),
        title: titleOf(entry.message),
        detail: detailOf(entry.message),
      }))).toEqual([
        {
          ordinal: notice.ordinal,
          type: 'transcript-notice',
          content: noticeContent,
          title: noticeTitle,
          detail: { type: 'cli-row' },
        },
        {
          ordinal: error.ordinal,
          type: 'error',
          content: errorContent,
          title: errorTitle,
          detail: { type: 'cli-row' },
        },
      ]);
      expect(fixture.client.eventsSince(eventCursor).filter((event) => (
        'chatId' in event
        && event.chatId === chatId
        && (
          event.type === 'agent-run-finished'
          || event.type === 'agent-run-failed'
          || event.type === 'chat-processing-updated'
          || event.type === 'chat-session-stopped'
        )
      ))).toEqual([]);

      const errorSearch = await fixture.client.waitForChatSearch(
        { query: 'chatrowerrorvisible', chatIds: [chatId], limit: 20 },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(errorSearch.results).toEqual([]);
      const noticeSearch = await fixture.client.waitForChatSearch(
        { query: 'chatrownoticevisible', chatIds: [chatId], limit: 20 },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(noticeSearch.results).toEqual([]);
      const titleSearch = await fixture.client.waitForChatSearch(
        { query: 'chatrownoticetitlevisible', chatIds: [chatId], limit: 20 },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(titleSearch.results).toEqual([]);
      const errorTitleSearch = await fixture.client.waitForChatSearch(
        { query: 'chatrowerrortitlevisible', chatIds: [chatId], limit: 20 },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(errorTitleSearch.results).toEqual([]);

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, heldTurn.turnId)).type).toBe(
        'agent-run-finished',
      );

      const contextTurn = await fixture.client.runDirectChat({
        chatId,
        content: 'chat-row-context-probe',
        agent: fixture.directAgents.openAi,
      });
      const contextRequest = await fixture.fakeProviders.openAi.waitForRequest(
        { lastUserText: 'chat-row-context-probe' },
        { afterId: heldRequest.id },
      );
      expect((await fixture.client.waitForTurnTerminal(chatId, contextTurn.turnId)).type).toBe(
        'agent-run-finished',
      );
      const providerRequestJson = JSON.stringify(contextRequest.body.messages);
      expect(providerRequestJson).not.toContain(errorContent);
      expect(providerRequestJson).not.toContain(noticeContent);
      expect(providerRequestJson).not.toContain(errorTitle);
      expect(providerRequestJson).not.toContain(noticeTitle);

      await fixture.restartGarcon();
      const persisted = await fixture.client.getMessages(chatId, { limit: 200 });
      expect(persisted.transcriptViewId).toBe(initial.transcriptViewId);
      expect(persisted.messages.filter((entry) => (
        entry.ordinal === notice.ordinal || entry.ordinal === error.ordinal
      )).map((entry) => ({
        ordinal: entry.ordinal,
        type: entry.message.type,
        content: contentOf(entry.message),
        title: titleOf(entry.message),
        detail: detailOf(entry.message),
      }))).toEqual([
        {
          ordinal: notice.ordinal,
          type: 'transcript-notice',
          content: noticeContent,
          title: noticeTitle,
          detail: { type: 'cli-row' },
        },
        {
          ordinal: error.ordinal,
          type: 'error',
          content: errorContent,
          title: errorTitle,
          detail: { type: 'cli-row' },
        },
      ]);

      const replay = await fixture.client.subscribe(
        chatId,
        initial.transcriptViewId,
        notice.ordinal - 1,
        error.ordinal,
      );
      expect(replay.messages.map((entry) => ({
        ordinal: entry.ordinal,
        type: entry.message.type,
        content: contentOf(entry.message),
        title: titleOf(entry.message),
        detail: detailOf(entry.message),
      }))).toEqual([
        {
          ordinal: notice.ordinal,
          type: 'transcript-notice',
          content: noticeContent,
          title: noticeTitle,
          detail: { type: 'cli-row' },
        },
        {
          ordinal: error.ordinal,
          type: 'error',
          content: errorContent,
          title: errorTitle,
          detail: { type: 'cli-row' },
        },
      ]);
    }, { namedWorkspace: WORKSPACE });
  }, 30_000);
});
