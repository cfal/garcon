import { describe, expect, test } from 'bun:test';
import { assistantContents, countUserContent, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { displayBodies, displayRequest } from '../../support/transcript-display.js';

describe('reconnect and transcript stability', () => {
  test('reconnects while processing with view-qualified display and control snapshots', async () => {
    await withIntegrationFixture('reconnect-while-processing', async fixture => {
      const chatId = fixture.newChatId();
      const clientMessageId = crypto.randomUUID();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'reconnect-a' });
      const accepted = await fixture.client.startDirectChat({
        chatId, clientMessageId, content: 'reconnect-a', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await held.received;
      const before = await fixture.client.getMessages(chatId);
      const input = before.messages.find(entry => entry.message.type === 'user-message')!;
      await fixture.client.disconnect();
      await fixture.client.reconnect();
      const cursor = fixture.client.markEvents();
      const recovered = await fixture.client.reconnectState([chatId]);
      expect(recovered.processing).toEqual({ outcome: 'snapshot', chats: [{ chatId, phase: 'running' }] });
      expect(recovered.controlResults).toMatchObject([{ chatId, outcome: 'snapshot' }]);
      const open = await fixture.client.openDisplay({ chatId, expectedTranscriptViewId: before.transcriptViewId,
        reason: 'reconnect', outstandingClientMessageIds: [clientMessageId, 'synthetic-missing-input'] });
      expect(open.processingPhase).toBe('running');
      expect(open.submissions).toEqual([
        { clientMessageId, ordinal: input.ordinal },
        { clientMessageId: 'synthetic-missing-input', ordinal: null },
      ]);
      const request = displayRequest(open);
      const window = await fixture.client.waitForDisplayWindow(request);
      const hydrated = await displayBodies(fixture.client, request, window);
      expect(userContents(hydrated.bodies)).toEqual(['reconnect-a']);
      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, { afterIndex: cursor })).type).toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(completed.transcriptViewId).toBe(before.transcriptViewId);
      expect(countUserContent(completed.messages, 'reconnect-a')).toBe(1);
      expect(completed.resendCandidates).toEqual([]);
    });
  });

  test('[TLV5-L02.04-SERVER-01] repeated reads preserve one view and one committed user row', async () => {
    await withIntegrationFixture('repeated-messages-while-processing', async fixture => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'repeated-read' });
      const accepted = await fixture.client.startDirectChat({
        chatId, content: 'repeated-read', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await held.received;
      const pages = await Promise.all(Array.from({ length: 5 }, () => fixture.client.getMessages(chatId)));
      expect(new Set(pages.map(page => page.transcriptViewId)).size).toBe(1);
      for (const page of pages) {
        expect(countUserContent(page.messages, 'repeated-read')).toBe(1);
        expect(page.resendCandidates).toEqual([]);
      }
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId)).type).toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(completed.transcriptViewId).toBe(pages[0]!.transcriptViewId);
      expect(assistantContents(completed.messages)).toEqual(['echo:repeated-read']);
    });
  });

  test('[TLV5-L03.03-SERVER-01] recovers committed output after a socket gap without raw replay', async () => {
    await withIntegrationFixture('reconnect-display-gap', async fixture => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'missed-delta' });
      const accepted = await fixture.client.startDirectChat({
        chatId, content: 'missed-delta', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await held.received;
      const initial = await fixture.client.getMessages(chatId);
      const observer = await fixture.connectObserver('gap-terminal');
      await fixture.client.disconnect();
      held.releaseEcho();
      await observer.waitForTurnTerminal(chatId, accepted.turnId);
      await fixture.client.reconnect();
      const open = await fixture.client.openDisplay({ chatId, expectedTranscriptViewId: initial.transcriptViewId,
        reason: 'reconnect', outstandingClientMessageIds: [] });
      expect(open.sourceHead).toBeGreaterThan(initial.lastOrdinal);
      const request = displayRequest(open);
      const window = await fixture.client.waitForDisplayWindow(request);
      const bodies = await displayBodies(fixture.client, request, window);
      expect(userContents(bodies.bodies)).toEqual(['missed-delta']);
      expect(assistantContents(bodies.bodies)).toEqual(['echo:missed-delta']);
      expect(new Set(bodies.bodies.map(row => row.ordinal)).size).toBe(bodies.bodies.length);
      expect(fixture.client.rawEvents().some(event => typeof event === 'object' && event !== null
        && ['chat-messages', 'chat-subscribed'].includes(String((event as Record<string, unknown>).type)))).toBe(false);
      expect(await fixture.client.displayWindow(request)).toEqual(window);
    });
  });

  test('rejects an obsolete display view with a typed stale-view error', async () => {
    await withIntegrationFixture('reconnect-stale-cursor', async fixture => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startDirectChat({
        chatId, content: 'stale-cursor', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      expect(await rejectionOf(fixture.client.openDisplay({ chatId, expectedTranscriptViewId: crypto.randomUUID(),
        reason: 'reconnect', outstandingClientMessageIds: [] }))).toMatchObject({ status: 409, body: { errorCode: 'STALE_TRANSCRIPT_VIEW' } });
      const canonical = await fixture.client.getMessages(chatId);
      expect(userContents(canonical.messages)).toEqual(['stale-cursor']);
      const open = await fixture.client.openDisplay({ chatId, reason: 'reconnect', outstandingClientMessageIds: [] });
      expect(open.transcriptViewId).toBe(canonical.transcriptViewId);
    });
  });

  test('pages one stable raw HTTP view and reloads it from Direct native history', async () => {
    await withIntegrationFixture('view-qualified-paging', async fixture => {
      const chatId = fixture.newChatId();
      for (const content of ['page-first', 'page-second', 'page-third']) {
        const input = { chatId, content, agent: fixture.directAgents.openAi };
        const accepted = content === 'page-first'
          ? await fixture.client.startDirectChat({ ...input, projectPath: fixture.dirs.project })
          : await fixture.client.runDirectChat(input);
        await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      }
      let page = await fixture.client.getMessages(chatId, { limit: 2 });
      const viewId = page.transcriptViewId;
      let reconstructed = [...page.messages], pageCount = 1;
      while (page.hasMore) {
        if (page.nextBeforeOrdinal === null) throw new Error('Missing raw continuation');
        page = await fixture.client.getMessages(chatId, { limit: 2, beforeOrdinal: page.nextBeforeOrdinal, transcriptViewId: viewId });
        expect(page.transcriptViewId).toBe(viewId);
        reconstructed = [...page.messages, ...reconstructed];
        if (++pageCount > 10) throw new Error('Raw pagination did not converge');
      }
      expect(pageCount).toBeGreaterThan(1);
      const ordinals = reconstructed.map(entry => entry.ordinal);
      expect(ordinals).toEqual([...new Set(ordinals)].sort((a, b) => a - b));
      expect(userContents(reconstructed)).toEqual(['page-first', 'page-second', 'page-third']);
      const reloaded = await fixture.client.reloadChat(chatId);
      expect(reloaded.transcriptViewId).not.toBe(viewId);
      expect(reloaded).not.toHaveProperty('messages');
      const reloadedPage = await fixture.client.getMessages(chatId, { beforeOrdinal: reloaded.lastOrdinal + 1, transcriptViewId: reloaded.transcriptViewId });
      expect(userContents(reloadedPage.messages)).toEqual(['page-first', 'page-second', 'page-third']);
      expect(assistantContents(reloadedPage.messages)).toEqual(['echo:page-first', 'echo:page-second', 'echo:page-third']);
    });
  });

  test('[TLV5-PAGE.02-SERVER-01] rejects an HTTP page cursor from another transcript view', async () => {
    await withIntegrationFixture('view-qualified-http-paging', async fixture => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startDirectChat({
        chatId, content: 'view-qualified-page', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      const latest = await fixture.client.getMessages(chatId, { limit: 1 });
      expect(typeof latest.nextBeforeOrdinal).toBe('number');
      expect(await rejectionOf(fixture.client.getMessages(chatId, {
        limit: 1, beforeOrdinal: latest.nextBeforeOrdinal!, transcriptViewId: crypto.randomUUID(),
      }))).toMatchObject({ status: 409, body: { errorCode: 'STALE_TRANSCRIPT_VIEW' } });
    });
  });
});
