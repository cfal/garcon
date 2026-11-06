import { expect, test } from 'bun:test';
import type { WorkflowPlan } from '../../../common/workflows.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('disabled workflows do not poll or load the graph while ordinary chat completes', async () => {
  await withE2eFixture('workflow-disabled-browser', async fixture => {
    const requests: string[] = [];
    fixture.page.on('request', request => requests.push(request.url()));
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    const chatId = fixture.integration.newChatId();
    const started = await fixture.integration.client.startDirectChat({ chatId, agent: fixture.integration.directAgents.openAi,
      projectPath: fixture.integration.executionDirs.project, content: 'Synthetic ordinary conversation without workflows' });
    await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
    expect(requests.filter(url => url.includes('/api/v1/workflows') || url.includes('WorkflowGraph'))).toEqual([]);
    fixture.assertNoBrowserErrors();
  });
}, 60_000);

test('mobile workflow navigation, exact decisions, tab semantics and historical inspection remain usable', async () => {
  await withE2eFixture('workflow-mobile-decisions', async fixture => {
    await fixture.integration.client.put('/api/v1/workflows/enabled', { enabled: true });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(390, 844);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('Menu');
    await fixture.page.waitForSelector('[role="dialog"]');
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Workflows');
    await app.clickMenuItem('Workflows');
    await fixture.page.waitForSelector('[data-workflow-surface]');
    await fixture.page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await app.clickButton('New draft');
    const plan: WorkflowPlan = { title: 'Synthetic delivery decision', goal: { kind: 'artifacts', taskIds: ['decision'] },
      policy: { concurrency: 1, allowRemoteWrites: false }, tasks: [{ id: 'decision', title: 'Synthetic acceptance',
        dependsOn: [], acceptance: [], retry: { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false },
        spec: { kind: 'approval', purpose: 'manual', requirements: [] } }] };
    await fixture.page.waitForSelector('textarea[aria-label="Workflow plan JSON"]');
    await app.fill('textarea[aria-label="Workflow plan JSON"]', JSON.stringify(plan));
    await app.clickDialogButton('Save draft');
    await app.waitForText('Review activation');
    expect(await fixture.page.evaluate(() => document.querySelector('[aria-label="Plan revision"]')?.closest('[role="tablist"]') === null)).toBe(true);
    await app.clickButton('Review activation');
    await fixture.page.waitForSelector('[role="dialog"] input[type="checkbox"]');
    expect(await fixture.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find(button => button.textContent?.trim() === 'Activate plan')?.disabled)).toBe(true);
    await fixture.page.evaluate(() => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click());
    await app.clickDialogButton('Activate plan');
    await fixture.page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('[data-workflow-surface] button')]
      .some(button => button.textContent?.trim() === 'Review' && !button.disabled));
    await app.clickButton('Review');
    await fixture.page.waitForSelector('[role="dialog"] input[type="checkbox"]');
    await fixture.page.evaluate(() => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click());
    await app.clickDialogButton('Approve manifest');
    await app.waitForText('1 of 1 complete');
    await fixture.page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-workflow-surface] [role="tab"]:nth-child(4)')!.click());
    await fixture.page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('[data-workflow-surface] button')]
      .some(button => button.textContent?.includes('decision') && button.textContent.includes('succeeded')));
    await fixture.page.evaluate(() => {
      const history = [...document.querySelectorAll<HTMLButtonElement>('[data-workflow-surface] button')]
        .find(button => button.textContent?.includes('decision') && button.textContent.includes('succeeded'));
      history!.click();
    });
    await app.waitForText('Historical attempt');
    fixture.assertNoBrowserErrors();
  });
}, 60_000);
