import { expect, test } from 'bun:test';
import { workflowPaths } from '../../../common/workflow-http.js';
import type { WorkflowPage, WorkflowRunDetail, WorkflowRunSummary } from '../../../common/workflow-runs.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const source = `version: 1
name: Browser workflow acceptance
inputs:
  batch: { type: string }
steps:
  - id: produce
    name: Produce evidence
    kind: command
    shell: sh
    command: "printf '%s %s' browser evidence"
  - id: review
    name: Review evidence
    kind: decision
    on: { kind: once, signal: produce.turn_completed }
    bindings: { batch: inputs.batch, report: signal }
    prompt: "Approve {{batch}}: {{report}}"
    choices: { approve: Approve batch }
  - id: finish
    kind: command
    shell: sh
    on: { kind: once, signal: review.approve }
    command: "printf '%s %s' batch approved"
`;

test('publishes and starts YAML in the browser, opens its Shell chat, and approves via the run viewer', async () => {
  await withE2eFixture('workflow-runs-browser-smoke', async fixture => {
    const { integration, page } = fixture;
    const app = new SpaDriver(page, integration);
    const surface = '[data-workspace-surface-id][aria-hidden="false"]';
    const sidebar = '[data-workspace-chat-list-panel][aria-hidden="false"]';
    const studio = `${surface} [aria-label="New Workflow"]`;
    const viewer = `${surface} [aria-label="Workflow run"]`;
    const selectedDefinition = `${studio} select[id$="-definition"]`;
    const step = (id: string) => `${viewer} [data-workflow-step="${id}"]`;
    const click = async (selector: string) => {
      await page.waitForSelector(selector, { timeout: 15_000 });
      await page.$eval(selector, element => {
        if (!(element instanceof HTMLButtonElement) || element.disabled || element.closest('[aria-hidden="true"], [inert], [hidden]')) {
          throw new Error('Expected an enabled control in the visible workspace');
        }
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') throw new Error('Matched a hidden workflow control');
        }
        element.click();
      });
    };
    const waitForText = async (selector: string, text: string) => {
      await page.waitForFunction((target, expected) => document.querySelector<HTMLElement>(target)?.innerText.includes(expected),
        { timeout: 15_000 }, selector, text);
    };

    await app.setViewport(1920, 900);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await click(`${sidebar} button[aria-label="New Workflow"]`);
    await page.waitForSelector(`${studio} h1`);
    await app.clickButton('Definition editor');
    await app.clickButton('Paste definition');
    await page.waitForSelector('[role="dialog"] textarea');
    await app.fill('[role="dialog"] textarea', source);
    await app.clickDialogButton('Paste definition');
    await waitForText(`${studio} [aria-label="Definition editor"] h2`, 'Browser workflow acceptance');
    await app.openWorkspaceWindowActions(await app.workspaceWindowIdForSurface('new-workflow'));
    await app.clickMenuItem('Close tab');
    await page.waitForSelector(studio, { hidden: true });
    await click(`${sidebar} button[aria-label="New Workflow"]`);
    await waitForText(`${studio} [aria-label="Definition editor"] h2`, 'Browser workflow acceptance');
    await app.clickButton('Publish');
    await waitForText(`${studio} [role="status"]`, 'Published revision 1.');
    await app.clickButton('New run');
    const definition = await page.waitForFunction(selector =>
      [...(document.querySelector<HTMLSelectElement>(selector)?.options ?? [])]
        .find(option => option.textContent?.includes('Browser workflow acceptance'))?.value || false,
    { timeout: 15_000 }, selectedDefinition);
    try {
      const value = await definition.jsonValue();
      if (!value) throw new Error('Published workflow is missing from the definition picker');
      // Lightpanda does not update select.value when Puppeteer only sets option.selected.
      await page.$eval(selectedDefinition, (element, next) => {
        const select = element as HTMLSelectElement;
        select.value = next;
        if (select.disabled || select.value !== next) throw new Error('Published definition cannot be selected');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    } finally {
      await definition.dispose();
    }
    const input = `${studio} fieldset:first-of-type input[type="text"]`;
    const folder = `${studio} [data-slot="project-path-field"] input`;
    await page.waitForSelector(input);
    await app.fill(input, 'sample batch');
    await page.waitForSelector(folder);
    await app.fill(folder, integration.executionDirs.project);
    await app.clickButton('Start workflow');

    await click(step('review'));
    await waitForText(viewer, 'Approve sample batch: browser evidence');
    const { items } = await integration.client.get<WorkflowPage<WorkflowRunSummary>>(workflowPaths.runs);
    expect(items).toMatchObject([{ kind: 'published', name: 'Browser workflow acceptance', revision: 1 }]);
    const runId = items[0]!.id;
    const getRun = () => integration.client.get<WorkflowRunDetail>(`${workflowPaths.run}?${new URLSearchParams({ runId })}`);
    const waiting = await getRun();
    expect(waiting.pinnedRevision.source).toBe(source);
    expect(waiting.steps.find(entry => entry.step.id === 'finish')?.instances).toEqual([]);
    const chatId = waiting.steps.find(entry => entry.step.id === 'produce')?.instances[0]?.attempts[0]?.chatId;
    if (!chatId) throw new Error('Missing Shell chat for the published workflow');

    await click(step('produce'));
    await app.clickButton('Open chat');
    await app.waitForSelectedChat(chatId);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-message-type="command-output"]')]
      .some(row => !row.closest('[aria-hidden="true"], [inert], [hidden]') && row.textContent?.includes('browser evidence')),
    { timeout: 15_000 });
    const runButton = `${sidebar} [data-sidebar-workflow-run="${runId}"] button:not([aria-expanded])`;
    await click(runButton);
    await page.waitForSelector(`${runButton}[aria-current="page"]`);
    await click(step('review'));
    await app.clickButton('Approve batch');
    await waitForText(`${viewer} header`, 'Succeeded');
    const completed = await getRun();
    expect(completed.status).toBe('succeeded');
    expect(completed.inputs).toEqual({ batch: 'sample batch' });
    expect(completed.signals).toMatchObject([
      { ref: { stepId: 'produce', signal: 'turn_completed' }, payload: 'browser evidence' },
      { ref: { stepId: 'review', signal: 'approve' }, source: { kind: 'decision', actor: { name: 'integration' } } },
      { ref: { stepId: 'finish', signal: 'turn_completed' }, payload: 'batch approved' },
    ]);
    fixture.assertNoBrowserErrors();
  });
}, 75_000);
