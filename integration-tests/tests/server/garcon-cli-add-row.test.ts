import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { CliPresentationStyle } from '../../../common/cli-presentation.js';
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
  readonly type: CliPresentationStyle;
  readonly format: 'plain' | 'markdown';
}

async function runAddRow(
  fixture: IntegrationFixture,
  chatId: string,
  type: CliPresentationStyle,
  title: string,
  content: string,
  options: { readonly color?: string; readonly markdown?: boolean } = {},
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
      ...(options.color ? ['--color', options.color] : []),
      ...(options.markdown ? ['--markdown'] : []),
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
    /^chat id: (\d{16})\ntranscript view id: ([^\n]+)\nordinal: (\d+)\ntype: (info|notice|error|custom)\nformat: (plain|markdown)\nstatus: (appended|duplicate)\n$/,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) {
    throw new Error(`Unexpected add-row output: ${JSON.stringify(stdout)}`);
  }
  return {
    chatId: match[1],
    transcriptViewId: match[2],
    ordinal: Number(match[3]),
    type: match[4] as AddRowCliResult['type'],
    format: match[5] as AddRowCliResult['format'],
    status: match[6] as AddRowCliResult['status'],
  };
}

async function runStatus(fixture: IntegrationFixture, chatId: string): Promise<string> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'cli/main.ts',
      '--config-dir', fixture.dirs.config,
      '--workspace', WORKSPACE,
      '--server', fixture.garcon.baseUrl,
      'status', chatId,
      '--messages', '200',
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
  return stdout;
}

function contentOf(message: ChatMessage): string | null {
  return 'content' in message && typeof message.content === 'string'
    ? message.content
    : null;
}

function presentationOf(message: ChatMessage): unknown {
  return 'presentation' in message ? message.presentation : undefined;
}

function formatOf(message: ChatMessage): unknown {
  return 'format' in message ? message.format : undefined;
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

      const infoContent = 'chatrowinfovisible user-only checkpoint';
      const noticeContent = 'chatrownoticevisible user-only checkpoint';
      const errorContent = 'chatrowerrorvisible user-only checkpoint';
      const infoTitle = 'chatrowinfotitlevisible Consultation status';
      const noticeTitle = 'chatrownoticetitlevisible Deployment';
      const errorTitle = 'chatrowerrortitlevisible Release validation';
      const customContent = '**chatrowcustomvisible deployment complete**';
      const customTitle = 'chatrowcustomtitlevisible Custom deployment';
      const info = await runAddRow(fixture, chatId, 'info', infoTitle, infoContent);
      const notice = await runAddRow(fixture, chatId, 'notice', noticeTitle, noticeContent);
      const error = await runAddRow(fixture, chatId, 'error', errorTitle, errorContent);
      const custom = await runAddRow(
        fixture,
        chatId,
        'custom',
        customTitle,
        customContent,
        { color: '7C3AED,c4b5fd', markdown: true },
      );
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) => contentOf(entry.message) === customContent),
        'the custom chat row broadcast',
        { afterIndex: eventCursor },
      );

      expect(info).toEqual({
        chatId,
        transcriptViewId: initial.transcriptViewId,
        ordinal: info.ordinal,
        type: 'info',
        format: 'plain',
        status: 'appended',
      });
      expect(notice).toEqual({
        chatId,
        transcriptViewId: initial.transcriptViewId,
        ordinal: info.ordinal + 1,
        type: 'notice',
        format: 'plain',
        status: 'appended',
      });
      expect(error).toEqual({
        chatId,
        transcriptViewId: initial.transcriptViewId,
        ordinal: notice.ordinal + 1,
        type: 'error',
        format: 'plain',
        status: 'appended',
      });
      expect(custom).toEqual({
        chatId,
        transcriptViewId: initial.transcriptViewId,
        ordinal: error.ordinal + 1,
        type: 'custom',
        format: 'markdown',
        status: 'appended',
      });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(providerRequestCount);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(controlBefore);
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({ isProcessing: true });

      const chatRowEvents = fixture.client.eventsSince(eventCursor).flatMap((event) => (
        event.type === 'chat-messages' && event.chatId === chatId
          ? event.messages.filter((entry) => (
              [info.ordinal, notice.ordinal, error.ordinal, custom.ordinal].includes(entry.ordinal)
            ))
          : []
      ));
      expect(chatRowEvents.map((entry) => ({
        ordinal: entry.ordinal,
        type: entry.message.type,
        content: contentOf(entry.message),
        title: titleOf(entry.message),
        presentation: presentationOf(entry.message),
        format: formatOf(entry.message),
      }))).toEqual([
        {
          ordinal: info.ordinal,
          type: 'cli-row',
          content: infoContent,
          title: infoTitle,
          presentation: { style: 'info' },
          format: 'plain',
        },
        {
          ordinal: notice.ordinal,
          type: 'cli-row',
          content: noticeContent,
          title: noticeTitle,
          presentation: { style: 'notice' },
          format: 'plain',
        },
        {
          ordinal: error.ordinal,
          type: 'cli-row',
          content: errorContent,
          title: errorTitle,
          presentation: { style: 'error' },
          format: 'plain',
        },
        {
          ordinal: custom.ordinal,
          type: 'cli-row',
          content: customContent,
          title: customTitle,
          presentation: {
            style: 'custom',
            customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
          },
          format: 'markdown',
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

      const infoSearch = await fixture.client.waitForChatSearch(
        { query: 'chatrowinfovisible', chatIds: [chatId], limit: 20 },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(infoSearch.results).toEqual([]);

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
      const infoTitleSearch = await fixture.client.waitForChatSearch(
        { query: 'chatrowinfotitlevisible', chatIds: [chatId], limit: 20 },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(infoTitleSearch.results).toEqual([]);
      const customSearch = await fixture.client.waitForChatSearch(
        { query: 'chatrowcustomvisible', chatIds: [chatId], limit: 20 },
        (response) => response.index.pendingChatCount === 0,
      );
      expect(customSearch.results).toEqual([]);

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
      expect(providerRequestJson).not.toContain(infoContent);
      expect(providerRequestJson).not.toContain(errorContent);
      expect(providerRequestJson).not.toContain(noticeContent);
      expect(providerRequestJson).not.toContain(errorTitle);
      expect(providerRequestJson).not.toContain(infoTitle);
      expect(providerRequestJson).not.toContain(noticeTitle);
      expect(providerRequestJson).not.toContain(customContent);
      expect(providerRequestJson).not.toContain(customTitle);

      await fixture.restartGarcon();
      const persisted = await fixture.client.getMessages(chatId, { limit: 200 });
      expect(persisted.transcriptViewId).toBe(initial.transcriptViewId);
      expect(persisted.messages.filter((entry) => (
        [info.ordinal, notice.ordinal, error.ordinal, custom.ordinal].includes(entry.ordinal)
      )).map((entry) => ({
        ordinal: entry.ordinal,
        type: entry.message.type,
        content: contentOf(entry.message),
        title: titleOf(entry.message),
        presentation: presentationOf(entry.message),
        format: formatOf(entry.message),
      }))).toEqual([
        {
          ordinal: info.ordinal,
          type: 'cli-row',
          content: infoContent,
          title: infoTitle,
          presentation: { style: 'info' },
          format: 'plain',
        },
        {
          ordinal: notice.ordinal,
          type: 'cli-row',
          content: noticeContent,
          title: noticeTitle,
          presentation: { style: 'notice' },
          format: 'plain',
        },
        {
          ordinal: error.ordinal,
          type: 'cli-row',
          content: errorContent,
          title: errorTitle,
          presentation: { style: 'error' },
          format: 'plain',
        },
        {
          ordinal: custom.ordinal,
          type: 'cli-row',
          content: customContent,
          title: customTitle,
          presentation: {
            style: 'custom',
            customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
          },
          format: 'markdown',
        },
      ]);

      const status = await runStatus(fixture, chatId);
      expect(status).toContain(`cli-row (CLI info) — ${infoTitle}`);
      expect(status).toContain(`cli-row (CLI notice) — ${noticeTitle}`);
      expect(status).toContain(`cli-row (CLI error) — ${errorTitle}`);
      expect(status).toContain(`cli-row (CLI custom) — ${customTitle}`);

      const replay = await fixture.client.subscribe(
        chatId,
        initial.transcriptViewId,
        info.ordinal - 1,
        custom.ordinal,
      );
      expect(replay.messages.map((entry) => ({
        ordinal: entry.ordinal,
        type: entry.message.type,
        content: contentOf(entry.message),
        title: titleOf(entry.message),
        presentation: presentationOf(entry.message),
        format: formatOf(entry.message),
      }))).toEqual([
        {
          ordinal: info.ordinal,
          type: 'cli-row',
          content: infoContent,
          title: infoTitle,
          presentation: { style: 'info' },
          format: 'plain',
        },
        {
          ordinal: notice.ordinal,
          type: 'cli-row',
          content: noticeContent,
          title: noticeTitle,
          presentation: { style: 'notice' },
          format: 'plain',
        },
        {
          ordinal: error.ordinal,
          type: 'cli-row',
          content: errorContent,
          title: errorTitle,
          presentation: { style: 'error' },
          format: 'plain',
        },
        {
          ordinal: custom.ordinal,
          type: 'cli-row',
          content: customContent,
          title: customTitle,
          presentation: {
            style: 'custom',
            customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
          },
          format: 'markdown',
        },
      ]);
    }, { namedWorkspace: WORKSPACE });
  }, 30_000);
});
