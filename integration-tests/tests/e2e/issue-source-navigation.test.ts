import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { createIssueSource } from '../../support/issue-source-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('opens a cold source chat at an older visible outcome using one targeted page', async () => {
  await withE2eFixture('issue-source-exact', async (fixture) => {
    const { target, issueId } = await createIssueSource(fixture.integration, 110);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1440, 900);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.selectWorkspaceWindowSurface('Open Issues');
    await fixture.page.waitForSelector(`[data-issue-id="${issueId}"]`);
    await app.clickButton(`Open ${issueId}`);
    await fixture.page.waitForSelector('.issue-detail-title');
    await app.clickButton('Activity');
    await app.waitForText('Open source');
    const reads: string[] = [];
    fixture.page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/chats/messages' && url.searchParams.has('beforeOrdinal')) reads.push(request.url());
    });
    await app.clickButton('Open source');
    await fixture.page.waitForSelector(`[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`);
    expect(reads).toHaveLength(1);
    expect(new URL(reads[0]!).searchParams.get('beforeOrdinal')).toBe(String(target.ordinal + 1));
    expect(new URL(reads[0]!).searchParams.get('transcriptViewId')).toBe(target.transcriptViewId);
    fixture.assertNoBrowserErrors();
  });
});

test('opens reloaded chats with a notice and leaves deleted sources disabled', async () => {
  await withE2eFixture('issue-source-reloaded', async (fixture) => {
    const { chatId, issueId } = await createIssueSource(fixture.integration);
    await fixture.integration.client.reloadChat(chatId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1440, 900);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.selectWorkspaceWindowSurface('Open Issues');
    await fixture.page.waitForSelector(`[data-issue-id="${issueId}"]`);
    await app.clickButton(`Open ${issueId}`);
    await fixture.page.waitForSelector('.issue-detail-title');
    await app.clickButton('Activity');
    await app.waitForText('Open source');
    await app.clickButton('Open source');
    await app.waitForText('Transcript was reloaded; exact row unavailable.');
    await fixture.page.waitForSelector('[data-chat-scroll-viewport]');
    await fixture.integration.client.deleteChat(chatId);
    await app.selectWorkspaceWindowSurfaceById('singleton:issues');
    await fixture.page.waitForSelector('.issue-detail-title');
    await app.clickButton('Activity');
    await fixture.page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.trim() === 'Open source' && button.disabled));
    fixture.assertNoBrowserErrors();
  });
});
