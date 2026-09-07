import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

// The server-side contract is covered by tests/server/self-handoff.test.ts. This
// asserts the half of `/handoff` that only the browser can answer: that the SPA
// navigates to the continuation rather than leaving the user in the chat they
// just handed off from.
describe('Lightpanda self handoff', () => {
  test('creates a continuation and focuses it', async () => {
    await withE2eFixture('self-handoff-focus', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-handoff-source');
      await app.waitForText('echo:ui-handoff-source');

      const source = (await fixture.integration.client.listChats()).sessions.find((entry) =>
        entry.preview.firstMessage === 'ui-handoff-source');
      if (!source) throw new Error('Source chat was not listed.');

      await app.submitComposerWithEnter('/handoff continue the work', 'Send message');

      // The composer submission must land the user in the new chat.
      const continuationId = await app.waitForSelectedChatChange(source.id);
      expect(continuationId).not.toBe(source.id);

      const chats = (await fixture.integration.client.listChats()).sessions;
      expect(chats).toHaveLength(2);
      const continuation = chats.find((entry) => entry.id === continuationId);
      expect(continuation).toBeDefined();
      // Same agent: a continuation, not a switch.
      expect(continuation?.agentId).toBe(source.agentId);
      // Named and ordered like any other chat rather than left orphaned.
      expect(continuation?.orderGroup).not.toBe('orphan');

      // The source is untouched and still reachable.
      await app.openChat(source.id);
      await app.waitForExactTextCount('ui-handoff-source', 1);

      fixture.assertNoBrowserErrors();
    });
  }, 90_000);
});
