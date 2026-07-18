import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda reconnect transcript stability', () => {
  test('reloads during processing without duplicate transcript or queue rows', async () => {
    await withE2eFixture('reconnect-transcript', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const active = fixture.integration.fakeOpenAi.holdNext({ lastUserText: 'ui-reconnect-a' });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startDirectChat('ui-reconnect-a');
      await active.received;
      await app.sendComposer('ui-reconnect-b');
      await app.waitForQueuedPreview('ui-reconnect-b');

      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: beforeReloadConnections });
      await app.waitForExactTextCount('ui-reconnect-a', 1);
      await app.waitForQueuedPreview('ui-reconnect-b');

      active.releaseEcho();
      await app.waitForText('echo:ui-reconnect-a');
      await fixture.integration.fakeOpenAi.waitForRequest({ lastUserText: 'ui-reconnect-b' });
      await app.waitForText('echo:ui-reconnect-b');
      await app.waitForExactTextCount('ui-reconnect-a', 1);
      await app.waitForExactTextCount('echo:ui-reconnect-a', 1);
      await app.waitForExactTextCount('ui-reconnect-b', 1);
      await app.waitForExactTextCount('echo:ui-reconnect-b', 1);

      expect(fixture.integration.fakeOpenAi.requests().filter((request) =>
        request.lastUserText === 'ui-reconnect-a')).toHaveLength(1);
      expect(fixture.integration.fakeOpenAi.requests().filter((request) =>
        request.lastUserText === 'ui-reconnect-b')).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
