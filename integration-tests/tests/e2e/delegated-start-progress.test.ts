import { describe, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import { COMPACTION_MODEL, prepareDelegatedHistory, requestSnapshotChild,
  waitForStartOutcome } from '../../support/delegated-start-progress.js';

describe('Lightpanda delegated startup', () => {
  test('opens the accepted child during compaction and preserves milestones across chat switches and reload', async () => {
    await withE2eFixture('delegated-start-progress', async (fixture) => {
      const integration = fixture.integration;
      const parent = await prepareDelegatedHistory(integration);
      const app = new SpaDriver(fixture.page, integration);
      await app.openChat(parent);
      await fixture.waitForSpaWebSocket();
      const compacting = integration.fakeProviders.openAi.holdNext({ model: COMPACTION_MODEL });
      const { cursor } = await requestSnapshotChild(integration, parent);
      const accepted = await waitForStartOutcome(integration, parent, 'accepted', cursor);
      if (accepted.status !== 'accepted') throw new Error('Missing child');
      await compacting.received;
      const link = `a[href="/chat/${accepted.chatId}"]`;
      await fixture.page.waitForFunction((selector) => {
        const target = [...document.querySelectorAll<HTMLAnchorElement>(selector)]
          .find((element) => element.textContent?.trim() === 'Open chat');
        if (!target) return false;
        target.click();
        return true;
      }, {}, link);
      await app.waitForSelectedChat(accepted.chatId);
      await app.waitForText('Compacting inherited context.');
      for (let index = 0; index < 3; index++) {
        await app.clickSidebarChatById(parent);
        await app.waitForSelectedChat(parent);
        await app.clickSidebarChatById(accepted.chatId);
        await app.waitForSelectedChat(accepted.chatId);
        await app.waitForText('Compacting inherited context.');
      }
      await app.openChat(accepted.chatId);
      await app.waitForText('Compacting inherited context.');
      compacting.releaseText('<summary>Synthetic browser context.</summary>');
      await waitForStartOutcome(integration, parent, 'completed', cursor);
      await app.waitForChatProcessing(false);
      await fixture.page.waitForFunction((chatId) => {
        const browser = globalThis as typeof globalThis & {
          __garconSpaWsEvents?: import('../../../common/ws-events.js').ServerWsMessage[];
        };
        return browser.__garconSpaWsEvents?.some((event) => event.type === 'chat-messages'
          && event.chatId === chatId && event.messages.some(({ message }) => message.type === 'transcript-notice'
            && message.detail?.type === 'agent-start-progress' && message.detail.phase === 'started'));
      }, {}, accepted.chatId);
      fixture.assertNoBrowserErrors();
    });
  }, 120_000);
});
