import { expect, test } from 'bun:test';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import {
  isCompleteTranscriptAnchorResponse, parseTranscriptAnchorResponse,
  transcriptAnchorContinuation, transcriptAnchorCursor,
  type TranscriptAnchorPage, type TranscriptAnchorRequest,
} from '../../../common/transcript-anchor-page.js';
import { seedCombinedAnchorHistory } from '../../support/combined-anchor-history.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

async function read(fixture: IntegrationFixture, request: TranscriptAnchorRequest): Promise<TranscriptAnchorPage> {
  const wire = await fixture.client.post<unknown>('/api/v1/chats/combined-messages', request);
  const page = parseTranscriptAnchorResponse(request, wire);
  if (!isCompleteTranscriptAnchorResponse(page)) throw new Error('Synthetic history is unavailable');
  expect(JSON.stringify(wire)).not.toContain('not-public');
  expect(page.endOrdinal - page.startOrdinal).toBeLessThanOrEqual(200);
  return page;
}

test('combined HTTP history partitions both directions, preserves raw reads, and fixes W under live append', async () => {
  await withIntegrationFixture('combined-anchor-paging', async fixture => {
    const { chatId, transcriptViewId, head, schemaVersion } = await seedCombinedAnchorHistory(fixture);
    expect(schemaVersion).toBe(3);
    const initial = await read(fixture, { chatId, direction: 'backward', anchorsRemaining: 2, purpose: 'activation' });
    expect(initial.pageStatus).toBe('partial');
    const live = await fixture.client.runDirectChat({ chatId, content: 'Synthetic live append', agent: fixture.directAgents.openAi });
    await fixture.client.waitForTurnTerminal(chatId, live.turnId);

    let cursor = initial.startOrdinal;
    let page = initial;
    const backward: TranscriptMessage[] = [...page.messages];
    while (page.pageStatus === 'partial') {
      const request = transcriptAnchorContinuation(page)!;
      page = await read(fixture, request);
      expect(page.endOrdinal).toBe(cursor);
      expect(page.watermarkOrdinal).toBe(head);
      expect(page.lastOrdinal).toBeGreaterThan(head);
      cursor = page.startOrdinal;
      backward.unshift(...page.messages);
      await fixture.client.ping();
    }
    expect(backward.filter(entry => entry.message.type === 'bash-tool-use')).toHaveLength(585);
    expect(new Set(backward.map(entry => entry.ordinal)).size).toBe(backward.length);

    let forwardRequest: TranscriptAnchorRequest = {
      chatId, transcriptViewId, direction: 'forward', cursorOrdinal: 0,
      watermarkOrdinal: head, anchorsRemaining: 200,
    };
    const forward: TranscriptMessage[] = [];
    let rawEnd = 1;
    for (;;) {
      const next = await read(fixture, forwardRequest);
      expect(next.startOrdinal).toBe(rawEnd);
      rawEnd = next.endOrdinal;
      forward.push(...next.messages);
      if (next.pageStatus === 'exhausted') break;
      forwardRequest = transcriptAnchorContinuation(next) ?? {
        chatId, transcriptViewId, direction: 'forward', cursorOrdinal: transcriptAnchorCursor(next),
        watermarkOrdinal: head, anchorsRemaining: 200,
      };
    }
    expect(rawEnd).toBe(head + 1);
    const raw: TranscriptMessage[] = [];
    let beforeOrdinal = head + 1;
    for (;;) {
      const response = await fixture.client.getMessages(chatId, { transcriptViewId, beforeOrdinal, limit: 200 });
      raw.unshift(...response.messages);
      if (response.nextBeforeOrdinal === null) break;
      beforeOrdinal = response.nextBeforeOrdinal;
    }
    expect(forward).toEqual(raw);
    const fresh = await read(fixture, { chatId, transcriptViewId, direction: 'forward', cursorOrdinal: head, anchorsRemaining: 100 });
    expect(fresh.watermarkOrdinal).toBeGreaterThan(head);
    expect(fresh.messages.some(entry => entry.message.type === 'user-message' && entry.message.content === 'Synthetic live append')).toBe(true);

    const ahead = await fixture.client.fetch('/api/v1/chats/combined-messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, transcriptViewId, direction: 'forward', cursorOrdinal: fresh.lastOrdinal + 1, anchorsRemaining: 100 }),
    });
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toMatchObject({ errorCode: 'TRANSCRIPT_CURSOR_AHEAD' });
    await fixture.client.reloadChat(chatId);
    const stale = await fixture.client.fetch('/api/v1/chats/combined-messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, transcriptViewId, direction: 'backward', cursorOrdinal: head + 1, anchorsRemaining: 100 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ errorCode: 'STALE_TRANSCRIPT_VIEW' });
  });
}, 120_000);
