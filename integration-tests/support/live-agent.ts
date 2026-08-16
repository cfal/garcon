import { expect } from 'bun:test';
import type { ServerWsMessage } from '../../common/ws-events.js';
import { assistantContents } from './chat-assertions.js';
import { GarconWsRequestError } from './garcon-client.js';
import type { IntegrationFixture } from './integration-fixture.js';

export const LIVE_TURN_TIMEOUT_MS = 90_000;
// Claude keeps a turn active through background continuations, so activity can outlive the
// turn-terminal event by a wide margin.
const RELOAD_SETTLE_TIMEOUT_MS = 30_000;
// Each retry rebuilds the view from native history, so poll gently.
export const POLL_INTERVAL_MS = 1_000;

export function liveMarker(label: string): string {
  return `GARCON_LIVE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function exactReplyPrompt(value: string): string {
  return `Reply with exactly ${value}. Do not use tools.`;
}

// A prompt that may still be unanswered when the next one is dispatched gets folded into it, so
// it must not forbid what that successor asks for. Otherwise the merged instruction contradicts
// itself and the answer depends on which half the model picks.
export function foldableReplyPrompt(value: string): string {
  return `Reply with exactly ${value}.`;
}

export function expectFinished(type: string): void {
  expect(type).toBe('agent-run-finished');
}

export function expectAssistantMarker(contents: readonly string[], value: string): void {
  expect(contents.some((content) => content.includes(value))).toBe(true);
}

// An interrupted turn proves it never completed by never delivering its completion reply. The
// prompt asks for that reply verbatim, so the reply is the whole message; a model that narrates
// the instruction it was given quotes the sentinel without having answered with it.
export function expectNoCompletionReply(contents: readonly string[], value: string): void {
  expect(contents.map((content) => content.trim())).not.toContain(value);
}

export function expectStoppedTurnEventOrder(
  events: readonly ServerWsMessage[],
  chatId: string,
  turnId: string,
): void {
  const stopped = events.findIndex((event) =>
    event.type === 'chat-session-stopped'
    && event.chatId === chatId
    && event.intent === 'stop'
    && event.outcome === 'interrupt-requested');
  const idle = events.findIndex((event) =>
    event.type === 'chat-processing-updated'
    && event.chatId === chatId
    && event.phase === null);

  expect(stopped).toBeGreaterThanOrEqual(0);
  expect(idle).toBeGreaterThan(stopped);
  expect(events).not.toContainEqual(expect.objectContaining({
    type: 'agent-run-failed',
    chatId,
    turnId,
  }));
}

function expectVisibleResponseBeforeSettlement(input: {
  events: readonly ServerWsMessage[];
  chatId: string;
  turnId: string | undefined;
  marker?: string;
}): void {
  const processingStarted = input.events.findIndex((event) =>
    event.type === 'chat-processing-updated'
    && event.chatId === input.chatId
    && event.phase !== null);
  const assistantResponse = input.events.findIndex((event) =>
    event.type === 'chat-messages'
    && event.chatId === input.chatId
    && event.messages.some((entry) =>
      entry.message.type === 'assistant-message'
      && (
        input.marker === undefined
        || entry.message.content.includes(input.marker)
      )));
  const processingStopped = input.events.findIndex((event, index) =>
    index > assistantResponse
    && event.type === 'chat-processing-updated'
    && event.chatId === input.chatId
    && event.phase === null);
  const terminal = input.events.findIndex((event) =>
    (event.type === 'agent-run-finished' || event.type === 'agent-run-failed')
    && event.chatId === input.chatId
    && event.turnId === input.turnId);

  expect(processingStarted).toBeGreaterThanOrEqual(0);
  expect(assistantResponse).toBeGreaterThan(processingStarted);
  expect(processingStopped).toBeGreaterThan(assistantResponse);
  expect(terminal).toBeGreaterThan(assistantResponse);
}

// A turn's execution reservation outlives its terminal event, so a reload issued as soon as the
// turn ends is briefly refused as CHAT_RUNNING. The refusal is retryable by contract.
export async function reloadFromNativeHistory(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<void> {
  const deadline = Date.now() + RELOAD_SETTLE_TIMEOUT_MS;
  for (;;) {
    try {
      await fixture.client.reloadChat(chatId);
      return;
    } catch (error) {
      const refusedWhileRunning = error instanceof GarconWsRequestError
        && error.response.code === 'CHAT_RUNNING';
      if (!refusedWhileRunning || Date.now() >= deadline) throw error;
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
}

// A provider transcript can still be flushing when its turn reports terminal, so a reload right
// after the turn can land on history that is missing the turn's final output.
export async function reloadUntilNativeContains(
  fixture: IntegrationFixture,
  chatId: string,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + RELOAD_SETTLE_TIMEOUT_MS;
  for (;;) {
    try {
      await reloadFromNativeHistory(fixture, chatId);
    } catch (error) {
      const providerHistoryStillFlushing = error instanceof GarconWsRequestError
        && error.response.code === 'HISTORY_LOAD_FAILED'
        && error.response.retryable === true;
      if (!providerHistoryStillFlushing || Date.now() >= deadline) throw error;
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    const page = await fixture.client.getMessages(chatId);
    if (assistantContents(page.messages).some((content) => content.includes(marker))) return;
    if (Date.now() >= deadline) {
      throw new Error(`Native history for ${chatId} never persisted ${marker}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

// Reloads until native history holds an assistant reply past a known point. Tool-driven turns
// cannot be pinned to an exact marker, so growth past the prior turn is the durable signal.
export async function reloadUntilNativeAnswersAfter(
  fixture: IntegrationFixture,
  chatId: string,
  afterSeq: number,
): Promise<Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>> {
  const deadline = Date.now() + RELOAD_SETTLE_TIMEOUT_MS;
  for (;;) {
    await reloadFromNativeHistory(fixture, chatId);
    const page = await fixture.client.getMessages(chatId);
    const answered = page.messages.some((entry) =>
      entry.ordinal > afterSeq && entry.message.type === 'assistant-message');
    if (answered) return page;
    if (Date.now() >= deadline) {
      throw new Error(`Native history for ${chatId} never answered past seq ${afterSeq}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

export async function waitForVisibleResponse(input: {
  fixture: IntegrationFixture;
  chatId: string;
  turnId: string | undefined;
  marker?: string;
  afterIndex: number;
}): Promise<void> {
  expectFinished((await input.fixture.client.waitForTurnTerminal(
    input.chatId,
    input.turnId,
    { afterIndex: input.afterIndex, timeoutMs: LIVE_TURN_TIMEOUT_MS },
  )).type);
  const assistantResponse = input.fixture.client.eventsSince(input.afterIndex).findIndex((event) =>
    event.type === 'chat-messages'
    && event.chatId === input.chatId
    && event.messages.some((entry) =>
      entry.message.type === 'assistant-message'
      && (input.marker === undefined || entry.message.content.includes(input.marker))));
  await input.fixture.client.waitForProcessing(input.chatId, false, {
    afterIndex: input.afterIndex + Math.max(assistantResponse + 1, 0),
    timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });
  expectVisibleResponseBeforeSettlement({
    events: input.fixture.client.eventsSince(input.afterIndex),
    chatId: input.chatId,
    turnId: input.turnId,
    marker: input.marker,
  });
}
