import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const MINUTE_MS = 60_000;
const RUN_TIMEOUT_MS = 90_000;

function nextRunAtWithBoundaryBuffer(now = Date.now()): string {
  let nextRunAt = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  if (nextRunAt - now < 10_000) nextRunAt += MINUTE_MS;
  return new Date(nextRunAt).toISOString();
}

test('scheduled prompts preview their schedule, report runs under the label they ran with, and open the created chat', async () => {
  await withChromiumFixture('scheduled-prompt-runs', async ({ page, integration }, phase) => {
    const { client } = integration;
    const agent = integration.directAgents.openAi;
    const initial = await client.getScheduledPrompts();
    await client.createScheduledPrompt({
      expectedRevision: initial.revision,
      scheduledPrompt: {
        schedule: {
          type: 'recurring',
          firstRunAtUtc: nextRunAtWithBoundaryBuffer(),
          intervalMinutes: 120,
          endAtUtc: null,
        },
        target: {
          type: 'new-chat',
          executorId: client.executorId,
          agentId: agent.agentId,
          projectPath: integration.executionDirs.project,
          model: agent.provider.model,
          apiProviderId: agent.provider.providerId,
          modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol,
          permissionMode: 'default',
          thinkingMode: 'none',
          agentSettingsById: { [agent.agentId]: agent.agentSettings },
          tags: [],
          preambleChoice: { mode: 'defaults' },
        },
        prompt: 'Summarize new error reports.\nGroup them by service.',
      },
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
    const list = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
    const row = list.getByRole('article').filter({ hasText: 'Summarize new error reports.' });
    await browserExpect(row.locator('[data-slot="scheduled-prompt-cadence"]')).toHaveText('Every 2 hours');
    await browserExpect(row.locator('[data-slot="scheduled-prompt-model"]')).toHaveText(agent.provider.model);

    phase('checking the schedule preview and its validation');
    await list.getByRole('button', { name: 'Add Prompt', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Add Scheduled Prompt', exact: true });
    await editor.locator('input[name="schedule-cadence"][value="recurring"]').check();
    const hourly = editor.getByRole('button', { name: 'Hourly', exact: true });
    await hourly.click();
    await browserExpect(hourly).toHaveAttribute('aria-pressed', 'true');
    const preview = editor.locator('[data-slot="scheduled-prompt-schedule-preview"]');
    await browserExpect(preview).toContainText('Hourly, forever');
    await browserExpect(preview.getByRole('listitem')).toHaveCount(3);
    await editor.getByLabel('First run date', { exact: true }).fill('2020-01-01');
    await browserExpect(preview).toHaveText('Choose a time at least one minute from now.');
    await browserExpect(editor.getByRole('button', { name: 'Save Prompt', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await editor.waitFor({ state: 'detached' });

    phase('waiting for the scheduled run to reach the open list');
    const lastRun = row.locator('[data-slot="scheduled-prompt-last-run"]');
    await browserExpect(lastRun).toContainText('Started a new chat', { timeout: RUN_TIMEOUT_MS });
    const run = (await client.getScheduledPrompts()).runLog.at(-1);
    expect(run).toMatchObject({ outcome: 'created-chat' });
    const createdChatId = run?.chatId;
    if (!createdChatId) throw new Error('The scheduled run did not report its chat');

    phase('editing the prompt after it ran');
    const ran = await client.getScheduledPrompts();
    const saved = ran.prompts[0];
    if (saved?.schedule.type !== 'recurring') throw new Error('The recurring prompt was not kept');
    await client.put('/api/v1/scheduled-prompts', {
      id: saved.id,
      expectedRevision: ran.revision,
      scheduledPrompt: {
        schedule: {
          type: 'recurring',
          firstRunAtUtc: saved.schedule.nextRunAt,
          intervalMinutes: saved.schedule.intervalMinutes,
          endAtUtc: saved.schedule.endAt,
        },
        target: saved.target,
        prompt: 'Triage overnight alerts.',
      },
    });
    const editedRow = list.getByRole('article').filter({ hasText: 'Triage overnight alerts.' });
    const editedLastRun = editedRow.locator('[data-slot="scheduled-prompt-last-run"]');
    await browserExpect(editedLastRun).toContainText('Started a new chat');

    phase('checking the run log keeps the label the run was recorded with');
    await list.getByRole('button', { name: 'Run Log', exact: true }).click();
    const runLog = page.getByRole('dialog', { name: 'Run Log', exact: true });
    const entry = runLog.locator('[data-slot="scheduled-run-entry"]');
    await browserExpect(entry).toHaveCount(1);
    await browserExpect(entry).toContainText('Started a new chat');
    await browserExpect(entry).toContainText('Summarize new error reports.');
    await browserExpect(entry).not.toContainText('Triage overnight alerts.');
    await runLog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await runLog.waitFor({ state: 'detached' });

    phase('opening the chat the run created');
    await editedLastRun.getByRole('button', { name: 'Open chat', exact: true }).click();
    await list.waitFor({ state: 'detached' });
    await browserExpect(page).toHaveURL(new RegExp(`/chat/${createdChatId}$`));
  });
}, 150_000);

test('scheduled prompt previews and save admission follow the clock while editing', async () => {
  await withChromiumFixture('scheduled-prompt-clock', async ({ page, integration }, phase) => {
    const { client } = integration;
    const agent = integration.directAgents.openAi;
    const firstRunAtUtc = '2030-01-01T09:00:00.000Z';
    const target = {
      type: 'new-chat' as const,
      executorId: client.executorId,
      agentId: agent.agentId,
      projectPath: integration.executionDirs.project,
      model: agent.provider.model,
      apiProviderId: agent.provider.providerId,
      modelEndpointId: agent.provider.endpointId,
      modelProtocol: agent.provider.protocol,
      permissionMode: 'default' as const,
      thinkingMode: 'none' as const,
      agentSettingsById: { [agent.agentId]: agent.agentSettings },
      tags: [],
      preambleChoice: { mode: 'defaults' as const },
    };
    const initial = await client.getScheduledPrompts();
    const once = await client.createScheduledPrompt({
      expectedRevision: initial.revision,
      scheduledPrompt: {
        schedule: { type: 'once', runAtUtc: firstRunAtUtc },
        target,
        prompt: 'One-off clock check',
      },
    });
    await client.createScheduledPrompt({
      expectedRevision: once.snapshot.revision,
      scheduledPrompt: {
        schedule: { type: 'recurring', firstRunAtUtc, intervalMinutes: 60, endAtUtc: null },
        target,
        prompt: 'Recurring clock check',
      },
    });

    await page.clock.install({ time: new Date('2030-01-01T08:59:30.000Z') });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
    const list = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
    await list.getByRole('article').filter({ hasText: 'One-off clock check' })
      .getByRole('button', { name: 'Edit prompt', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Scheduled Prompt', exact: true });
    const preview = editor.locator('[data-slot="scheduled-prompt-schedule-preview"]');
    const save = editor.getByRole('button', { name: 'Save Prompt', exact: true });
    await browserExpect(save).toBeEnabled();

    phase('letting the one-off expire without changing any inputs');
    await page.clock.fastForward(60_000);
    await browserExpect(preview).toHaveText('Choose a time at least one minute from now.');
    await browserExpect(save).toBeDisabled();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await editor.waitFor({ state: 'detached' });

    phase('advancing an untouched recurring anchor in both preview and saved schedule');
    await list.getByRole('article').filter({ hasText: 'Recurring clock check' })
      .getByRole('button', { name: 'Edit prompt', exact: true }).click();
    await browserExpect(preview.getByRole('listitem').first()).toContainText('10:00');
    await page.clock.fastForward(60 * MINUTE_MS);
    await browserExpect(preview.getByRole('listitem').first()).toContainText('11:00');
    await browserExpect(save).toBeEnabled();
    await save.click();
    await editor.waitFor({ state: 'detached' });
    const saved = (await client.getScheduledPrompts()).prompts.find(
      (prompt) => prompt.prompt === 'Recurring clock check',
    );
    expect(saved?.schedule.nextRunAt).toBe('2030-01-01T11:00:00.000Z');
  });
}, 60_000);
