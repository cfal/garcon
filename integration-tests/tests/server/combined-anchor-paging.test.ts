import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
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

test('same-view tail loss rejects an old watermark without fencing fresh reads or new commits', async () => {
  await withIntegrationFixture('combined-anchor-tail-loss', async fixture => {
    const { chatId, transcriptViewId, head } = await seedCombinedAnchorHistory(fixture);
    const initial = await read(fixture, { chatId, direction: 'backward', anchorsRemaining: 100 });
    const continuation = transcriptAnchorContinuation(initial);
    expect(continuation).not.toBeNull();
    const lowerHead = head - 20;
    await fixture.crashAndRestartGarcon({ beforeStart: async () => {
      const db = new Database(join(fixture.dirs.workspace, 'transcript-ledgers', chatId, 'ledger.sqlite'));
      try {
        expect(db.query('DELETE FROM transcript_rows WHERE view_id = ? AND ordinal > ?').run(transcriptViewId, lowerHead).changes).toBe(20);
      } finally { db.close(); }
    } });
    const rejected = await fixture.client.fetch('/api/v1/chats/combined-messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(continuation),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ errorCode: 'TRANSCRIPT_CURSOR_AHEAD' });
    const fresh = await read(fixture, { chatId, direction: 'backward', anchorsRemaining: 100 });
    expect(fresh).toMatchObject({ transcriptViewId, lastOrdinal: lowerHead, watermarkOrdinal: lowerHead });
    expect((await fixture.client.getMessages(chatId)).lastOrdinal).toBe(lowerHead);
    const marker = 'Synthetic input after tail loss';
    const turn = await fixture.client.runDirectChat({ chatId, content: marker, agent: fixture.directAgents.openAi });
    await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
    const appended = await read(fixture, { chatId, transcriptViewId, direction: 'forward', cursorOrdinal: lowerHead, anchorsRemaining: 100 });
    expect(appended.messages[0]).toMatchObject({ ordinal: lowerHead + 1, message: { type: 'user-message', content: marker } });
  });
}, 120_000);
