import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda multi-chat isolation', () => {
  test('keeps concurrent direct chats isolated while switching in the sidebar', async () => {
    await withE2eFixture('multi-chat', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const first = fixture.integration.fakeOpenAi.holdNext({ lastUserText: 'ui-multi-a' });
      const second = fixture.integration.fakeOpenAi.holdNext({ lastUserText: 'ui-multi-b' });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startDirectChat('ui-multi-a');
      await first.received;
      await app.startDirectChat('ui-multi-b');
      await second.received;

      expect((await fixture.integration.client.listChats()).sessions).toHaveLength(2);
      await app.clickSidebarChatContaining('ui-multi-a');
      await app.waitForExactTextCount('ui-multi-a', 1);
      expect(await app.exactTextCount('ui-multi-b')).toBe(0);
      first.releaseEcho();
      await app.waitForText('echo:ui-multi-a');

      await app.clickSidebarChatContaining('ui-multi-b');
      await app.waitForExactTextCount('ui-multi-b', 1);
      expect(await app.exactTextCount('echo:ui-multi-a')).toBe(0);
      second.releaseEcho();
      await app.waitForText('echo:ui-multi-b');

      expect(fixture.integration.fakeOpenAi.requests().filter((request) =>
        request.lastUserText === 'ui-multi-a')).toHaveLength(1);
      expect(fixture.integration.fakeOpenAi.requests().filter((request) =>
        request.lastUserText === 'ui-multi-b')).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
