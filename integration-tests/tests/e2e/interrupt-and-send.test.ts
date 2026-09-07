import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

// The interrupted prompt was never answered, so the resend fold carries it into the successor's
// prompt rather than losing it. One request, both inputs.
const FOLDED_PROMPT = 'ui-interrupt-a\n\nui-interrupt-b';

describe('Lightpanda interrupt and send', () => {
  test('interrupts the active turn and delivers the queued successor once', async () => {
    await withE2eFixture('interrupt-and-send', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const active = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: 'ui-interrupt-a' });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-interrupt-a');
      await active.received;

      await app.sendComposer('ui-interrupt-b');
      await app.waitForQueuedPreview('ui-interrupt-b');
      const activeAborted = active.expectAbort();
      await app.clickResponsiveAction('Send now');
      await activeAborted;
      await fixture.integration.fakeProviders.openAi.waitForRequest({ lastUserText: FOLDED_PROMPT });
      await app.waitForText('echo:ui-interrupt-a');
      await app.waitForExactUserMessageCount('ui-interrupt-b', 1);

      const body = await app.bodyText();
      expect(body).not.toContain('Failed to send');
      expect(body).not.toContain('Delivery not confirmed');
      expect(fixture.integration.fakeProviders.openAi.requests().filter((request) =>
        request.lastUserText === FOLDED_PROMPT)).toHaveLength(1);
      active.releaseText('stale response must be ignored');
      fixture.assertNoBrowserErrors();
    });
  });
});
