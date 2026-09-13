import { expect, test } from 'bun:test';
import { parseTicketHistoryPage } from '../../../common/ticket-responses.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { createTicketSource, resolveTicketSource } from '../../support/ticket-source-fixture.js';

test('resolves the exact visible outcome across restart and refuses replaced, missing, or deleted sources', async () => {
  await withIntegrationFixture('ticket-source-navigation', async (fixture) => {
    const { chatId, ticketId, source, target } = await createTicketSource(fixture, 110);
    expect(target.ordinal).toBeGreaterThan(source.ordinal);
    const latest = await fixture.client.getMessages(chatId, { limit: 50 });
    expect(latest.messages.some((entry) => entry.ordinal === target.ordinal)).toBe(false);
    const targetPage = await fixture.client.getMessages(chatId, {
      transcriptViewId: target.transcriptViewId, beforeOrdinal: target.ordinal + 1, limit: 50,
    });
    expect(targetPage.messages.length).toBeLessThanOrEqual(50);
    expect(targetPage.messages.find((entry) => entry.ordinal === target.ordinal)?.message).toMatchObject({
      type: 'transcript-notice', detail: { type: 'ticket-command-outcome', requestViewId: source.transcriptViewId, requestOrdinal: source.ordinal },
    });
    expect(await resolveTicketSource(fixture, { ...source, ordinal: target.ordinal })).toEqual({ kind: 'outcome-unavailable', chatId });
    await fixture.restartGarcon();
    expect(await resolveTicketSource(fixture, source)).toEqual({ kind: 'found', target });
    await fixture.client.reloadChat(chatId);
    expect(await resolveTicketSource(fixture, source)).toEqual({ kind: 'transcript-reloaded', chatId });
    await expect(fixture.client.getMessages(chatId, {
      transcriptViewId: target.transcriptViewId, beforeOrdinal: target.ordinal + 1, limit: 50,
    })).rejects.toMatchObject({ status: 409, body: { errorCode: 'STALE_TRANSCRIPT_VIEW' } });
    expect(parseTicketHistoryPage(await fixture.client.get(`/api/v1/tickets/history?ticketId=${ticketId}`)).items[0]?.source).toEqual(source);
    await fixture.client.deleteChat(chatId);
    await expect(resolveTicketSource(fixture, source)).rejects.toMatchObject({ status: 404, body: { errorCode: 'SESSION_NOT_FOUND' } });
  });
}, 60_000);
