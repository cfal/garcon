import { expect, test } from 'bun:test';
import { parseIssueHistoryPage } from '../../../common/issue-responses.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { createIssueSource, resolveIssueSource } from '../../support/issue-source-fixture.js';

test('resolves the exact visible outcome across restart and refuses replaced, missing, or deleted sources', async () => {
  await withIntegrationFixture('issue-source-navigation', async (fixture) => {
    const { chatId, issueId, source, target } = await createIssueSource(fixture, 110);
    expect(target.ordinal).toBeGreaterThan(source.ordinal);
    const latest = await fixture.client.getMessages(chatId, { limit: 50 });
    expect(latest.messages.some((entry) => entry.ordinal === target.ordinal)).toBe(false);
    const targetPage = await fixture.client.getMessages(chatId, {
      transcriptViewId: target.transcriptViewId, beforeOrdinal: target.ordinal + 1, limit: 50,
    });
    expect(targetPage.messages.length).toBeLessThanOrEqual(50);
    expect(targetPage.messages.find((entry) => entry.ordinal === target.ordinal)?.message).toMatchObject({
      type: 'transcript-notice', detail: { type: 'issue-command-outcome', requestViewId: source.transcriptViewId, requestOrdinal: source.ordinal },
    });
    expect(await resolveIssueSource(fixture, { ...source, ordinal: target.ordinal })).toEqual({ kind: 'outcome-unavailable', chatId });
    await fixture.restartGarcon();
    expect(await resolveIssueSource(fixture, source)).toEqual({ kind: 'found', target });
    await fixture.client.reloadChat(chatId);
    expect(await resolveIssueSource(fixture, source)).toEqual({ kind: 'transcript-reloaded', chatId });
    await expect(fixture.client.getMessages(chatId, {
      transcriptViewId: target.transcriptViewId, beforeOrdinal: target.ordinal + 1, limit: 50,
    })).rejects.toMatchObject({ status: 409, body: { errorCode: 'STALE_TRANSCRIPT_VIEW' } });
    expect(parseIssueHistoryPage(await fixture.client.get(`/api/v1/issues/history?issueId=${issueId}`)).items[0]?.source).toEqual(source);
    await fixture.client.deleteChat(chatId);
    await expect(resolveIssueSource(fixture, source)).rejects.toMatchObject({ status: 404, body: { errorCode: 'SESSION_NOT_FOUND' } });
  });
}, 60_000);
