import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda interrupt and send', () => {
  test('interrupts the active turn and delivers the queued successor once', async () => {
    await withE2eFixture('interrupt-and-send', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const active = fixture.integration.fakeOpenAi.holdNext({ lastUserText: 'ui-interrupt-a' });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startDirectChat('ui-interrupt-a');
      await active.received;

      await app.sendComposer('ui-interrupt-b');
      await app.waitForQueuedPreview('ui-interrupt-b');
      const activeAborted = active.expectAbort();
      await app.clickButton('Interrupt and send');
      await activeAborted;
      await fixture.integration.fakeOpenAi.waitForRequest({ lastUserText: 'ui-interrupt-b' });
      await app.waitForText('echo:ui-interrupt-b');
      await app.waitForExactTextCount('ui-interrupt-b', 1);

      const body = await app.bodyText();
      expect(body).not.toContain('Failed to send');
      expect(body).not.toContain('Delivery not confirmed');
      expect(fixture.integration.fakeOpenAi.requests().filter((request) =>
        request.lastUserText === 'ui-interrupt-b')).toHaveLength(1);
      active.releaseText('stale response must be ignored');
      fixture.assertNoBrowserErrors();
    });
  });
});
