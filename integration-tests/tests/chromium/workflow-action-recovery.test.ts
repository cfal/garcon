import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { workflowPaths } from '../../../common/workflow-http.js';
import type {
  WorkflowAddItemRequest, WorkflowDecisionRequest, WorkflowPage, WorkflowRunDetail, WorkflowRunSummary, WorkflowTestRequest,
} from '../../../common/workflow-runs.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

const source = `version: 1
name: Manual intake
steps:
  - id: gate
    kind: decision
    prompt: Collect findings?
    choices: {collect: Collect, skip: Skip}
  - id: research
    kind: agent
    agentId: claude
    model: haiku
    on: {kind: once, signal: gate.collect}
    prompt: Collect findings.
    signals:
      found: {delivery: many, payload: json, key: id, fields: {id: string, note: string}}
  - id: verify
    kind: decision
    on: {kind: each, signal: research.found}
    bindings: {note: signal.note}
    prompt: "Review {{note}}"
    choices: {ok: Accept finding}
`;

async function loseFirstReply<T>(page: Page, path: string): Promise<T[]> {
  const requests: T[] = [];
  await page.route(`**${path}`, async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length !== 1) return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    await route.abort('failed');
  });
  return requests;
}

test('reopening Studio retries the committed draft launch, not a second run', async () => {
  await withChromiumFixture('workflow-draft-launch-recovery', async ({ integration, page, withExpectedConsoleErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    const open = page.getByRole('button', { name: 'New Workflow', exact: true });
    await open.click();
    const studio = page.getByRole('region', { name: 'New Workflow' });
    await studio.getByRole('button', { name: 'Definition editor' }).click();
    const editor = studio.getByRole('region', { name: 'Definition editor' });
    await editor.getByRole('button', { name: 'Test run', exact: true }).click();
    const requests = await loseFirstReply<WorkflowTestRequest>(page, workflowPaths.testDraft);
    const retry = studio.getByRole('button', { name: 'Retry same launch' });
    await withExpectedConsoleErrors(['Failed to load resource: net::ERR_FAILED'], async () => {
      await studio.locator('form').getByRole('button', { name: 'Test run', exact: true }).click();
      await browserExpect(retry).toBeVisible();
    });
    const runs = async () => (await integration.client.get<WorkflowPage<WorkflowRunSummary>>(workflowPaths.runs)).items;
    const committed = await runs();
    expect(committed).toMatchObject([{ kind: 'test' }]);
    await page.locator('[data-workspace-window-tab-close="new-workflow"]').click();
    await browserExpect(studio).toHaveCount(0);
    await open.click();
    await browserExpect(retry).toBeVisible();
    expect(requests).toHaveLength(1);
    const first = requests[0]!;
    expect(first.operationId).toEqual(expect.any(String));
    await retry.click();
    await browserExpect(page.getByRole('region', { name: 'Workflow run', exact: true })
      .getByRole('heading', { name: committed[0]!.name, exact: true })).toBeVisible();
    expect(requests).toEqual([first, first]);
    expect(await runs()).toEqual(committed);
  });
}, 90_000);

test('retries a committed manual item after intake closes and archives without losing its evidence', async () => {
  await withChromiumFixture('workflow-manual-intake', async ({ integration, page, withExpectedConsoleErrors }) => {
    const { client, executionDirs } = integration;
    const run = await client.post<WorkflowRunDetail>(workflowPaths.testDraft, {
      source, inputs: {}, executionContext: { defaultTarget: { executorId: client.executorId, projectPath: executionDirs.project } },
    } satisfies WorkflowTestRequest);
    const detail = () => client.get<WorkflowRunDetail>(`${workflowPaths.run}?runId=${run.id}`);
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'New Workflow', exact: true }).click();
    await page.getByRole('region', { name: 'New Workflow' }).getByRole('button', { name: /Manual intake/ }).click();
    const viewer = page.getByRole('region', { name: 'Workflow run', exact: true });
    await viewer.locator('[data-workflow-step="verify"]').click();
    const add = viewer.getByRole('button', { name: 'Add item', exact: true });
    await add.click();
    await viewer.getByLabel('Item key (id)').fill('F-01');
    await viewer.getByLabel('JSON payload').fill('{"note":"manual evidence"}');
    const requests = await loseFirstReply<WorkflowAddItemRequest>(page, workflowPaths.addItem);
    const retry = viewer.getByRole('button', { name: 'Retry same action' });
    await withExpectedConsoleErrors(['Failed to load resource: net::ERR_FAILED'], async () => {
      await add.click();
      await browserExpect(retry).toBeVisible();
    });
    expect(requests).toHaveLength(1);
    const first = requests[0]!;
    const committed = await detail();
    expect(committed.signals).toMatchObject([{
      ref: { stepId: 'research', signal: 'found' }, key: 'F-01', payload: { id: 'F-01', note: 'manual evidence' },
      source: { kind: 'manual', actor: { name: 'integration' }, operationId: first.operationId },
    }]);
    expect(committed.amendments).toMatchObject([{
      kind: 'add-item', stepId: 'verify', signalId: committed.signals[0]!.id, operationId: first.operationId,
    }]);
    const closed = await client.post<WorkflowRunDetail>(workflowPaths.decide, {
      runId: run.id, instanceId: run.steps[0]!.instances[0]!.id, choice: 'skip', operationId: crypto.randomUUID(),
    } satisfies WorkflowDecisionRequest);
    expect(closed.steps.find(entry => entry.step.id === 'verify')).toMatchObject({
      intake: 'closed', instances: [{ trigger: { kind: 'signal', signalId: committed.signals[0]!.id }, status: 'awaiting-decision' }],
    });
    expect(await rejectionOf(client.post(workflowPaths.addItem, {
      ...first, operationId: crypto.randomUUID(), key: 'late', payload: { id: 'late', note: 'Too late' },
    } satisfies WorkflowAddItemRequest))).toMatchObject({ status: 409, body: { errorCode: 'WORKFLOW_CONFLICT' } });

    await retry.click();
    await browserExpect(viewer.getByText('Review manual evidence', { exact: true })).toBeVisible();
    await browserExpect(retry).toHaveCount(0);
    expect(requests).toEqual([first, first]);
    expect(await detail()).toEqual(closed);

    await viewer.getByRole('button', { name: 'Archive run' }).click();
    await page.getByRole('dialog', { name: 'Archive run' }).getByRole('button', { name: 'Archive run' }).click();
    await browserExpect(viewer.getByText(/Archived by integration/)).toBeVisible();
    expect(await detail()).toMatchObject({
      status: 'archived', archive: { actor: { name: 'integration' } }, signals: closed.signals, amendments: committed.amendments,
    });
    expect((await client.listChats()).sessions).toEqual([]);
  });
}, 90_000);
