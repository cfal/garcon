import { expect } from 'bun:test';
import type { ServerWsMessage } from '../../common/ws-events.js';
import type { IntegrationFixture } from './integration-fixture.js';

export const LIVE_TURN_TIMEOUT_MS = 90_000;

export function liveMarker(label: string): string {
  return `GARCON_LIVE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function exactReplyPrompt(value: string): string {
  return `Reply with exactly ${value}. Do not use tools.`;
}

export function expectFinished(type: string): void {
  expect(type).toBe('agent-run-finished');
}

export function expectAssistantMarker(contents: readonly string[], value: string): void {
  expect(contents.some((content) => content.includes(value))).toBe(true);
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
    && event.turnId === input.turnId
    && event.messages.some((entry) =>
      entry.message.type === 'assistant-message'
      && (
        input.marker === undefined
        || entry.message.content.includes(input.marker)
      )));
  const processingStopped = input.events.findIndex((event) =>
    event.type === 'chat-processing-updated'
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
  await input.fixture.client.waitForProcessing(input.chatId, false, {
    afterIndex: input.afterIndex,
    timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });
  expectVisibleResponseBeforeSettlement({
    events: input.fixture.client.eventsSince(input.afterIndex),
    chatId: input.chatId,
    turnId: input.turnId,
    marker: input.marker,
  });
}
