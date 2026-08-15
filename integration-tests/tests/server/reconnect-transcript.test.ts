import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  applyTranscriptAppend,
  type TranscriptMessage,
} from '../../../common/chat-view.js';
import { CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT } from '../../../common/chat-snapshot.js';
import {
  AssistantMessage,
  BashToolUseMessage,
  CompactionMessage,
  ToolResultMessage,
  UserMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import type { LedgerRowDraft } from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { countUserContent, userContents } from '../../support/chat-assertions.js';
import {
  type GarconTestClient,
  GarconWsRequestError,
} from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

function transcriptProjection(messages: readonly TranscriptMessage[]): Array<{
  ordinal: number;
  type: string;
  content?: string;
}> {
  return messages.map((entry) => ({
    ordinal: entry.ordinal,
    type: entry.message.type,
    ...('content' in entry.message && typeof entry.message.content === 'string'
      ? { content: entry.message.content }
      : {}),
  }));
}

interface ExactTranscriptRow {
  readonly ordinal: number;
  readonly type: string;
  readonly text: string;
}

interface ReplayPage {
  readonly messages: readonly TranscriptMessage[];
  readonly nextAfterOrdinal: number;
  readonly throughOrdinal: number;
  readonly hasMore: boolean;
  readonly frameBytes: number;
}

const REPLAY_BYTE_STRESS_ROW_COUNT = 24;
const REPLAY_BYTE_STRESS_TEXT = '\u{1F642}'.repeat(32 * 1024);

function exactTranscriptRow(entry: TranscriptMessage): ExactTranscriptRow {
  return {
    ordinal: entry.ordinal,
    type: entry.message.type,
    text: exactMessageText(entry.message),
  };
}

function exactMessageText(message: ChatMessage): string {
  switch (message.type) {
    case 'user-message':
    case 'assistant-message':
    case 'thinking':
    case 'error':
    case 'transcript-notice':
      return message.content;
    case 'bash-tool-use':
      return `$ ${message.command}`;
    case 'tool-result':
      return typeof message.content.raw === 'string'
        ? message.content.raw
        : JSON.stringify(message.content);
    case 'compaction':
      return message.summary;
    default:
      return JSON.stringify(message);
  }
}

function mixedReplayRows(
  firstOrdinal: number,
  count: number,
): { drafts: LedgerRowDraft[]; presented: ExactTranscriptRow[] } {
  const drafts: LedgerRowDraft[] = [];
  const presented: ExactTranscriptRow[] = [];
  const hiddenPrefixLength = Math.max(0, count - 1_000);

  for (let index = 0; index < count; index += 1) {
    const ordinal = firstOrdinal + index;
    const timestamp = new Date(Date.UTC(2026, 7, 15) + index).toISOString();
    if (index < hiddenPrefixLength) {
      drafts.push({
        kind: 'run-ended',
        at: timestamp,
        outcome: index % 2 === 0 ? 'finished' : 'interrupted',
        origin: index % 2 === 0 ? 'provider' : 'core',
        providerMeta: null,
      });
      continue;
    }

    const occurrence = index - hiddenPrefixLength;
    const toolId = `replay-tool-${occurrence}`;
    const byteStress = occurrence < REPLAY_BYTE_STRESS_ROW_COUNT
      ? `-${REPLAY_BYTE_STRESS_TEXT}`
      : '';
    let message: ChatMessage;
    let draft: LedgerRowDraft;
    switch (occurrence % 6) {
      case 0:
        message = new UserMessage(timestamp, `replay-user-${occurrence}${byteStress}`);
        draft = {
          kind: 'user-input',
          at: timestamp,
          detail: {
            clientMessageId: `replay-client-${occurrence}`,
            message,
            attachments: [],
            steer: false,
          },
          providerMeta: null,
        };
        break;
      case 1:
        message = new AssistantMessage(timestamp, `replay-assistant-${occurrence}${byteStress}`);
        draft = { kind: 'provider-row', at: timestamp, message, providerMeta: null };
        break;
      case 2:
        message = new BashToolUseMessage(
          timestamp,
          toolId,
          `printf replay-${occurrence}${byteStress}`,
        );
        draft = { kind: 'provider-row', at: timestamp, message, providerMeta: null };
        break;
      case 3:
        message = new ToolResultMessage(
          timestamp,
          `replay-tool-${occurrence - 1}`,
          { raw: `replay-result-${occurrence}${byteStress}` },
          false,
        );
        draft = { kind: 'provider-row', at: timestamp, message, providerMeta: null };
        break;
      case 4:
        message = new CompactionMessage(
          timestamp,
          'auto',
          `replay-compaction-${occurrence}${byteStress}`,
        );
        draft = { kind: 'provider-row', at: timestamp, message, providerMeta: null };
        break;
      default:
        message = new AssistantMessage(
          timestamp,
          `repeated-equal-assistant-content${byteStress}`,
        );
        draft = { kind: 'provider-row', at: timestamp, message, providerMeta: null };
        break;
    }
    drafts.push(draft);
    presented.push({ ordinal, type: message.type, text: exactMessageText(message) });
  }

  return { drafts, presented };
}

async function subscribeReplayPage(
  client: GarconTestClient,
  chatId: string,
  transcriptViewId: string,
  afterOrdinal: number,
  throughOrdinal?: number,
): Promise<ReplayPage> {
  const rawCursor = client.rawEvents().length;
  const response = await client.subscribe(
    chatId,
    transcriptViewId,
    afterOrdinal,
    throughOrdinal,
  );
  const raw = client.rawEvents().slice(rawCursor).find((event): event is Record<string, unknown> => (
    isRecord(event)
    && event.type === 'chat-subscribed'
    && event.clientRequestId === response.clientRequestId
  ));
  if (!raw) throw new Error('The raw transcript replay response was not recorded.');
  if (
    !Number.isSafeInteger(raw.nextAfterOrdinal)
    || !Number.isSafeInteger(raw.throughOrdinal)
    || typeof raw.hasMore !== 'boolean'
  ) {
    throw new Error(
      `Transcript replay response is not a bounded page: ${JSON.stringify({
        firstOrdinal: raw.firstOrdinal,
        lastOrdinal: raw.lastOrdinal,
        messageCount: response.messages.length,
        nextAfterOrdinal: raw.nextAfterOrdinal ?? null,
        throughOrdinal: raw.throughOrdinal ?? null,
        hasMore: raw.hasMore ?? null,
      })}`,
    );
  }
  return {
    messages: response.messages,
    nextAfterOrdinal: replayInteger(raw.nextAfterOrdinal, 'nextAfterOrdinal'),
    throughOrdinal: replayInteger(raw.throughOrdinal, 'throughOrdinal'),
    hasMore: raw.hasMore as boolean,
    frameBytes: new TextEncoder().encode(JSON.stringify(raw)).byteLength,
  };
}

async function replayAllPages(
  client: GarconTestClient,
  chatId: string,
  transcriptViewId: string,
): Promise<{ rows: ExactTranscriptRow[]; throughOrdinal: number }> {
  const rows: ExactTranscriptRow[] = [];
  let afterOrdinal = 0;
  let throughOrdinal: number | undefined;
  for (let pageCount = 0; pageCount < 1_000; pageCount += 1) {
    const page = await subscribeReplayPage(
      client,
      chatId,
      transcriptViewId,
      afterOrdinal,
      throughOrdinal,
    );
    throughOrdinal ??= page.throughOrdinal;
    expect(page.throughOrdinal).toBe(throughOrdinal);
    expect(page.nextAfterOrdinal).toBeGreaterThan(afterOrdinal);
    expect(page.nextAfterOrdinal - afterOrdinal)
      .toBeLessThanOrEqual(CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT);
    expect(page.frameBytes).toBeLessThanOrEqual(1_048_576);
    rows.push(...page.messages.map(exactTranscriptRow));
    afterOrdinal = page.nextAfterOrdinal;
    if (!page.hasMore) return { rows, throughOrdinal };
  }
  throw new Error('Restarted transcript replay did not converge.');
}

function replayInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Replay response has an invalid ${field}.`);
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('reconnect and transcript stability', () => {
  test('reconnects while processing with view-qualified transcript and control snapshots', async () => {
    await withIntegrationFixture('reconnect-while-processing', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'reconnect-a' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'reconnect-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      const beforeReconnect = await fixture.client.getMessages(chatId);
      expect(countUserContent(beforeReconnect.messages, 'reconnect-a')).toBe(1);
      expect(beforeReconnect.resendCandidates).toEqual([]);

      await fixture.client.disconnect();
      await fixture.client.reconnect();
      const reconnectCursor = fixture.client.markEvents();
      const state = await fixture.client.reconnectState([chatId]);
      expect(state.processing).toEqual({
        outcome: 'snapshot',
        chats: [{ chatId, phase: 'running' }],
      });
      expect(state.controlResults).toMatchObject([{ chatId, outcome: 'snapshot' }]);

      const subscription = await fixture.client.subscribe(
        chatId,
        beforeReconnect.transcriptViewId,
        beforeReconnect.lastOrdinal,
      );
      expect(subscription).toMatchObject({
        transcriptViewId: beforeReconnect.transcriptViewId,
        messages: [],
        firstOrdinal: beforeReconnect.lastOrdinal + 1,
        lastOrdinal: beforeReconnect.lastOrdinal,
        resendCandidates: [],
      });

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: reconnectCursor,
      })).type).toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(completed.transcriptViewId).toBe(beforeReconnect.transcriptViewId);
      expect(countUserContent(completed.messages, 'reconnect-a')).toBe(1);
      expect(completed.resendCandidates).toEqual([]);
    });
  });

  test('repeated reads preserve one view and one committed user row', async () => {
    await withIntegrationFixture('repeated-messages-while-processing', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'repeated-read' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'repeated-read',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;

      const pages = await Promise.all(
        Array.from({ length: 5 }, () => fixture.client.getMessages(chatId)),
      );
      expect(new Set(pages.map((page) => page.transcriptViewId)).size).toBe(1);
      for (const page of pages) {
        expect(countUserContent(page.messages, 'repeated-read')).toBe(1);
        expect(page.resendCandidates).toEqual([]);
      }
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId)).type)
        .toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(completed.transcriptViewId).toBe(pages[0]!.transcriptViewId);
      expect(completed.messages.filter((entry) =>
        entry.message.type === 'assistant-message')).toHaveLength(1);
    });
  });

  test('replays missed rows after a socket disconnect', async () => {
    await withIntegrationFixture('reconnect-replay-delta', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'missed-delta' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'missed-delta',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      const initial = await fixture.client.getMessages(chatId);
      await fixture.client.disconnect();
      held.releaseEcho();
      await fixture.client.reconnect();

      const reconnectCursor = fixture.client.markEvents();
      const state = await fixture.client.reconnectState([]);
      if (
        state.processing.outcome === 'snapshot'
        && state.processing.chats.some((entry) => entry.chatId === chatId)
      ) {
        await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
          afterIndex: reconnectCursor,
        });
      }
      const replay = await fixture.client.subscribe(
        chatId,
        initial.transcriptViewId,
        initial.lastOrdinal,
      );
      expect(replay.messages).toHaveLength(1);
      expect(replay.messages[0]!.message).toMatchObject({
        type: 'assistant-message',
        content: 'echo:missed-delta',
      });

      const applied = applyTranscriptAppend(initial.messages, replay, initial.lastOrdinal);
      expect(applied.status).toBe('applied');
      const canonical = await fixture.client.getMessages(chatId);
      expect(applied.messages).toEqual(canonical.messages);
      expect((await fixture.client.subscribe(
        chatId,
        initial.transcriptViewId,
        initial.lastOrdinal,
      )).messages).toEqual(replay.messages);
    });
  });

  test('replays fifty thousand mixed rows in bounded fixed-watermark pages', async () => {
    await withIntegrationFixture('reconnect-bounded-replay', async (fixture) => {
      const chatId = fixture.newChatId();
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'bounded-replay-initial',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      const initial = await fixture.client.getMessages(chatId);
      const generated = mixedReplayRows(initial.lastOrdinal + 1, 50_000);

      await fixture.restartGarcon({
        beforeStart: async () => {
          const store = new TranscriptLedgerStore(
            join(fixture.dirs.workspace, 'transcript-ledgers'),
          );
          try {
            const view = store.currentView(chatId);
            if (view?.viewId !== initial.transcriptViewId) {
              throw new Error('The replay fixture opened a different transcript view.');
            }
            for (let offset = 0; offset < generated.drafts.length; offset += 1_000) {
              store.append(
                chatId,
                view.viewId,
                generated.drafts.slice(offset, offset + 1_000),
              );
            }
          } finally {
            store.close();
          }
        },
      });

      const injectedThroughOrdinal = initial.lastOrdinal + generated.drafts.length;
      const expectedBeforeLive = [
        ...initial.messages.map(exactTranscriptRow),
        ...generated.presented,
      ];
      const liveContent = 'bounded-replay-concurrent-live';
      let liveTurn: Awaited<ReturnType<typeof fixture.client.runDirectChat>> | null = null;
      let liveCursor = -1;
      let afterOrdinal = 0;
      let throughOrdinal: number | undefined;
      let pageCount = 0;
      let sawHiddenOnlyPage = false;
      let sawByteLimitedPage = false;
      const replayed: ExactTranscriptRow[] = [];

      while (true) {
        const page = await subscribeReplayPage(
          fixture.client,
          chatId,
          initial.transcriptViewId,
          afterOrdinal,
          throughOrdinal,
        );
        pageCount += 1;
        throughOrdinal ??= page.throughOrdinal;
        expect(page.throughOrdinal).toBe(throughOrdinal);
        expect(throughOrdinal).toBe(injectedThroughOrdinal);
        expect(page.nextAfterOrdinal).toBeGreaterThan(afterOrdinal);
        expect(page.nextAfterOrdinal - afterOrdinal)
          .toBeLessThanOrEqual(CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT);
        expect(page.frameBytes).toBeLessThanOrEqual(1_048_576);
        expect(page.messages.length).toBeLessThanOrEqual(CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT);
        if (page.messages.length === 0) sawHiddenOnlyPage = true;
        if (
          page.hasMore
          && page.messages.length > 0
          && page.nextAfterOrdinal - afterOrdinal < CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT
        ) {
          sawByteLimitedPage = true;
        }
        for (const message of page.messages) {
          expect(message.ordinal).toBeGreaterThan(afterOrdinal);
          expect(message.ordinal).toBeLessThanOrEqual(page.nextAfterOrdinal);
        }
        replayed.push(...page.messages.map(exactTranscriptRow));

        if (pageCount === 1) {
          liveCursor = fixture.client.markEvents();
          liveTurn = await fixture.client.runDirectChat({
            chatId,
            content: liveContent,
            agent: fixture.directAgents.openAi,
          });
        }

        afterOrdinal = page.nextAfterOrdinal;
        if (!page.hasMore) break;
        if (pageCount > 1_000) throw new Error('Bounded transcript replay did not converge.');
      }

      expect(afterOrdinal).toBe(throughOrdinal);
      expect(pageCount).toBeGreaterThan(1);
      expect(sawHiddenOnlyPage).toBe(true);
      expect(sawByteLimitedPage).toBe(true);
      expect(replayed).toEqual(expectedBeforeLive);
      expect(new Set(replayed.map((row) => row.ordinal)).size).toBe(replayed.length);

      expect(liveTurn).not.toBeNull();
      await fixture.client.waitForTurnTerminal(chatId, liveTurn!.turnId, {
        afterIndex: liveCursor,
      });
      const liveRows = fixture.client.eventsSince(liveCursor).flatMap((event) => (
        event.type === 'chat-messages' && event.chatId === chatId
          ? event.messages.filter((message) => message.ordinal > throughOrdinal!)
          : []
      ));
      expect(liveRows.map(exactTranscriptRow)).toEqual([
        expect.objectContaining({ type: 'user-message', text: liveContent }),
        expect.objectContaining({ type: 'assistant-message', text: `echo:${liveContent}` }),
      ]);
      expect(new Set(liveRows.map((message) => message.ordinal)).size).toBe(liveRows.length);

      const interrupted = await subscribeReplayPage(
        fixture.client,
        chatId,
        initial.transcriptViewId,
        0,
      );
      expect(interrupted.hasMore).toBe(true);
      await fixture.client.disconnect();
      await fixture.client.reconnect();

      const restarted = await replayAllPages(
        fixture.client,
        chatId,
        initial.transcriptViewId,
      );
      expect(restarted.rows).toEqual([
        ...expectedBeforeLive,
        ...liveRows.map(exactTranscriptRow),
      ]);
      expect(restarted.throughOrdinal).toBeGreaterThan(throughOrdinal!);
    });
  }, 60_000);

  test('rejects an obsolete view cursor with a typed stale-view error', async () => {
    await withIntegrationFixture('reconnect-stale-cursor', async (fixture) => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'stale-cursor',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);

      await expect(fixture.client.subscribe(chatId, crypto.randomUUID(), 99_999))
        .rejects.toMatchObject({
          response: {
            requestType: 'chat-subscribe',
            code: 'STALE_TRANSCRIPT_VIEW',
            retryable: false,
            chatId,
          },
        });

      const canonical = await fixture.client.getMessages(chatId);
      expect(userContents(canonical.messages)).toEqual(['stale-cursor']);
      expect((await fixture.client.subscribe(
        chatId,
        canonical.transcriptViewId,
        canonical.lastOrdinal,
      )).messages).toEqual([]);
    });
  });

  test('pages one stable view and rejects reload for a chat without native history', async () => {
    await withIntegrationFixture('view-qualified-paging', async (fixture) => {
      const chatId = fixture.newChatId();
      for (const content of ['page-first', 'page-second', 'page-third']) {
        const accepted = content === 'page-first'
          ? await fixture.client.startDirectChat({
              chatId,
              content,
              projectPath: fixture.dirs.project,
              agent: fixture.directAgents.openAi,
            })
          : await fixture.client.runDirectChat({
              chatId,
              content,
              agent: fixture.directAgents.openAi,
            });
        await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      }

      let page = await fixture.client.getMessages(chatId, { limit: 2 });
      const viewId = page.transcriptViewId;
      let reconstructed = [...page.messages];
      let pageCount = 1;
      while (page.hasMore) {
        page = await fixture.client.getMessages(chatId, {
          limit: 2,
          beforeOrdinal: page.pageOldestOrdinal,
          transcriptViewId: viewId,
        });
        expect(page.transcriptViewId).toBe(viewId);
        reconstructed = [...page.messages, ...reconstructed];
        pageCount += 1;
        if (pageCount > 10) throw new Error('Transcript pagination did not converge.');
      }
      expect(pageCount).toBeGreaterThan(1);
      const ordinals = reconstructed.map((entry) => entry.ordinal);
      expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right));
      expect(new Set(ordinals).size).toBe(ordinals.length);
      for (const content of ['page-first', 'page-second', 'page-third']) {
        expect(countUserContent(reconstructed, content)).toBe(1);
      }

      let reloadFailure: unknown;
      try {
        await fixture.client.reloadChat(chatId);
      } catch (error) {
        reloadFailure = error;
      }
      expect(reloadFailure).toBeInstanceOf(GarconWsRequestError);
      expect((reloadFailure as GarconWsRequestError).response).toMatchObject({
        requestType: 'chat-reload',
        code: 'HISTORY_LOAD_FAILED',
        retryable: false,
        chatId,
      });
      expect(transcriptProjection((await fixture.client.getMessages(chatId)).messages))
        .toEqual(transcriptProjection(reconstructed));
    });
  });

  test('rejects an HTTP page cursor from another transcript view', async () => {
    await withIntegrationFixture('view-qualified-http-paging', async (fixture) => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'view-qualified-page',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      const latest = await fixture.client.getMessages(chatId, { limit: 1 });
      const query = new URLSearchParams({
        chatId,
        transcriptViewId: crypto.randomUUID(),
        limit: '1',
        beforeOrdinal: String(latest.pageOldestOrdinal),
      });

      const response = await fetch(`${fixture.client.baseUrl}/api/v1/chats/messages?${query}`);
      const body = await response.json() as { errorCode?: unknown };

      expect(response.status).toBe(409);
      expect(body.errorCode).toBe('STALE_TRANSCRIPT_VIEW');
    });
  });
});
