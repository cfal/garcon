import { test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { createSidebarDelegationFixture } from '../../support/sidebar-delegation-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('Appearance changes the delegation collapse default without overwriting manual choices', async () => {
  await withE2eFixture('sidebar-delegation-collapse', async (fixture) => {
    const { page, integration } = fixture;
    const {
      a: expandedParent, a1: expandedChild, b: otherParent, b1: otherChild,
    } = await createSidebarDelegationFixture(integration);
    const app = new SpaDriver(page, integration);
    await page.evaluateOnNewDocument(seedLocalSettings, { sidebarGroupingFields: [], sidebarNestDelegatedChats: true });
    await app.openChat(expandedParent);
    await fixture.waitForSpaWebSocket();
    const row = (id: string) => `[data-sidebar-virtual-row="${id}"]`;
    const settingLabel = 'Collapse delegated chat trees by default';
    const collapseSwitch = (checked: boolean) =>
      `[role="switch"][aria-label="${settingLabel}"][aria-checked="${checked}"]`;
    async function openAppearance() {
      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Settings');
      await app.clickMenuItem('Settings');
      await app.waitForDialogButtonEnabled('Appearance');
      await app.clickButton('Appearance');
    }
    async function changeDefault(enabled: boolean) {
      await openAppearance();
      await page.waitForSelector(collapseSwitch(!enabled));
      await app.clickDialogButton(settingLabel);
      await page.waitForSelector(collapseSwitch(enabled));
      await app.clickDialogButton('Close');
    }
    async function chooseBranchAction(id: string, action: string) {
      await app.openSidebarChatActionsById(id);
      await app.waitForMenuItemEnabled(action);
      await app.clickMenuItem(action);
    }

    await page.waitForSelector(row(expandedParent));
    await page.waitForSelector(row(otherParent));
    await page.waitForSelector(row(expandedChild), { hidden: true });
    await page.waitForSelector(row(otherChild), { hidden: true });

    await chooseBranchAction(expandedParent, 'Expand delegated chats');
    await page.waitForSelector(row(expandedChild));
    await app.openChat(expandedParent);
    await page.waitForSelector(row(otherParent));
    await page.waitForSelector(row(expandedChild));
    await page.waitForSelector(row(otherChild), { hidden: true });

    await changeDefault(false);
    await page.waitForSelector(row(otherChild));
    await changeDefault(true);
    await page.waitForFunction(selector => !document.querySelector(selector), {}, row(otherChild));
    await page.waitForSelector(row(expandedChild));

    await changeDefault(false);
    await page.waitForSelector(row(otherChild));
    await chooseBranchAction(otherParent, 'Collapse delegated chats');
    await changeDefault(true);
    await page.waitForSelector(row(expandedChild));
    await changeDefault(false);

    const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
    await app.openChat(expandedParent);
    await fixture.waitForSpaWebSocket({ afterConnectionCount: beforeReloadConnections });
    await openAppearance();
    await page.waitForSelector(collapseSwitch(false));
    await app.clickDialogButton('Close');
    await page.waitForSelector(row(otherParent));
    await page.waitForSelector(row(expandedChild));
    await page.waitForSelector(row(otherChild), { hidden: true });

    await integration.client.deleteChat(otherParent);
    await page.waitForFunction(selector => !document.querySelector(selector), {}, row(otherParent));
    await page.waitForFunction(key => {
      const saved = JSON.parse(localStorage.getItem('pref_sidebar_project_collapse')!);
      return !saved.collapsedProjectKeys.includes(key);
    }, { timeout: 5000 }, `delegation:${otherParent}`);
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
