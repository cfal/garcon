import { expect, test } from 'bun:test';
import type { WebSocket as BrowserWebSocket, WebSocketRoute } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';
import type { SnippetsMutationResponse, SnippetsSnapshot } from '../../../common/snippets.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

function pathnameOf(url: string): string {
  return new URL(url).pathname;
}

test('expands eligible snippets/preambles locally, skips project preflight on fallbacks, and picks up WS edits', async () => {
  await withChromiumFixture('snippet-expansion-fast-path', async (fixture, phase) => {
    const { page, integration } = fixture;
    const { client } = integration;

    let expandCalls = 0;
    let projectResolveCalls = 0;
    let snippetGetRequests = 0;
    let preambleGetRequests = 0;
    let snippetGetDone = 0;
    let preambleGetDone = 0;
    page.on('request', (request) => {
      const pathname = pathnameOf(request.url());
      if (pathname === '/api/v1/snippets/expand') expandCalls += 1;
      if (pathname === '/api/v1/projects/resolve') projectResolveCalls += 1;
      if (request.method() !== 'GET') return;
      if (pathname === '/api/v1/snippets') snippetGetRequests += 1;
      if (pathname === '/api/v1/preambles') preambleGetRequests += 1;
    });
    page.on('response', (response) => {
      if (response.request().method() !== 'GET' || !response.ok()) return;
      const pathname = pathnameOf(response.url());
      if (pathname === '/api/v1/snippets') snippetGetDone += 1;
      if (pathname === '/api/v1/preambles') preambleGetDone += 1;
    });

    let snippetSnapshot = await client.get<SnippetsSnapshot>('/api/v1/snippets');
    const createSnippet = async (shortName: string, template: string, defaultArguments = '') => {
      const response = await client.post<SnippetsMutationResponse>('/api/v1/snippets', {
        expectedRevision: snippetSnapshot.revision,
        snippet: { shortName, template, defaultArguments },
      });
      snippetSnapshot = response.snapshot;
      return snippetSnapshot.snippets.find((entry) => entry.shortName === shortName)!;
    };
    const localReview = await createSnippet('local_review', 'Review {{arguments}} for {{chat_id}}', 'open PRs');
    await createSnippet('path_review', 'Review in {{project_path}}');
    const dateReview = await createSnippet('date_review', 'Summary on {{current_date}}');

    let preambleSnapshot = await client.get<PreamblesSnapshot>('/api/v1/preambles');
    const createNamedPreamble = async (snippetShortName: string, title: string, content: string) => {
      const response = await client.post<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: preambleSnapshot.revision,
        preamble: {
          enabled: false,
          title,
          snippetShortName,
          content,
          scope: { type: 'global' },
        },
      });
      preambleSnapshot = response.snapshot;
      return preambleSnapshot.preambles.find((entry) => entry.snippetShortName === snippetShortName)!;
    };
    const localCtx = await createNamedPreamble(
      'local_ctx',
      'Local context',
      'Static context for {{chat_id}} with literal {{arguments}}',
    );
    await createNamedPreamble(
      'manual_ctx',
      'Manual context',
      'Context for {{chat_id}} on {{current_date}}',
    );

    const chatId = integration.newChatId();
    const turn = await client.startDirectChat({
      chatId,
      content: 'Synthetic fast-path conversation.',
      projectPath: integration.executionDirs.project,
      agent: integration.directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, turn.turnId);

    phase('Phase 1: checking immediate composer fast paths, fallbacks without project resolve, and reconnect recovery');
    let activeSocket: WebSocketRoute | undefined;
    let browserSocket: BrowserWebSocket | undefined;
    let allowConnect = true;
    page.on('websocket', (socket) => {
      browserSocket = socket;
    });
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      if (!allowConnect) {
        socket.close({ code: 1000, reason: 'Synthetic offline interval' });
        return;
      }
      activeSocket = socket;
      socket.connectToServer();
    });
    await page.goto(`${integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`);
    const composer = page.getByPlaceholder('Reply...', { exact: true });
    await browserExpect(composer).toBeVisible();

    await composer.pressSequentially(';;');
    const palette = page.getByRole('dialog', { name: 'Insert Snippet', exact: true });
    const localOption = palette.getByRole('option', { name: /^local_review\b/ });
    await localOption.waitFor();
    await browserExpect.poll(() => snippetGetDone >= 1 && preambleGetDone >= 1).toBe(true);

    expandCalls = 0;
    projectResolveCalls = 0;
    await localOption.click();
    const argsDialog = page.getByRole('dialog', {
      name: 'Arguments for /snippet local_review',
      exact: true,
    });
    await browserExpect(argsDialog.getByRole('textbox', { name: 'Arguments', exact: true })).toHaveValue(
      'open PRs',
    );
    await argsDialog.getByRole('button', { name: 'Insert snippet', exact: true }).click();
    await browserExpect(composer).toHaveValue(`Review open PRs for ${chatId}`);
    expect(expandCalls).toBe(0);
    expect(projectResolveCalls).toBe(0);

    await composer.fill('/s local_ctx');
    await composer.press('Enter');
    await browserExpect(composer).toHaveValue(
      `Static context for ${chatId} with literal {{arguments}}`,
    );
    expect(expandCalls).toBe(0);
    expect(projectResolveCalls).toBe(0);

    await composer.fill('/s path_review');
    await composer.press('Enter');
    await browserExpect(composer).toHaveValue(`Review in ${integration.executionDirs.project}`);
    expect(expandCalls).toBe(1);
    expect(projectResolveCalls).toBe(0);

    await composer.fill('/s manual_ctx');
    await composer.press('Enter');
    await browserExpect(composer).toHaveValue(
      new RegExp(`^Context for ${chatId} on \\d{4}-\\d{2}-\\d{2}$`),
    );
    expect(expandCalls).toBe(2);
    expect(projectResolveCalls).toBe(0);

    if (!activeSocket || !browserSocket) throw new Error('Browser socket did not connect');
    allowConnect = false;
    snippetGetRequests = 0;
    preambleGetRequests = 0;
    snippetGetDone = 0;
    preambleGetDone = 0;
    const closed = new Promise<void>((resolve) => browserSocket!.once('close', () => resolve()));
    activeSocket.close({ code: 1000, reason: 'Synthetic disconnect' });
    await closed;

    const updatedLocal = await client.put<SnippetsMutationResponse>('/api/v1/snippets', {
      expectedRevision: snippetSnapshot.revision,
      id: localReview.id,
      snippet: {
        shortName: 'local_review',
        template: 'Updated {{arguments}} for {{chat_id}}',
        defaultArguments: 'open PRs',
      },
    });
    snippetSnapshot = updatedLocal.snapshot;
    await client.put<PreamblesMutationResponse>('/api/v1/preambles', {
      expectedRevision: preambleSnapshot.revision,
      id: localCtx.id,
      preamble: {
        enabled: false,
        title: 'Local context',
        snippetShortName: 'local_ctx',
        content: 'Reconnected context for {{chat_id}}',
        scope: { type: 'global' },
      },
    });
    expect(snippetGetRequests).toBe(0);
    expect(preambleGetRequests).toBe(0);
    expect(snippetGetDone).toBe(0);
    expect(preambleGetDone).toBe(0);

    allowConnect = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await browserExpect.poll(() => snippetGetDone >= 1 && preambleGetDone >= 1, { timeout: 15_000 }).toBe(true);

    await composer.fill('');
    await composer.pressSequentially(';;');
    await browserExpect(palette.getByRole('option', { name: /^local_review\b/ })).toContainText(
      'Updated {{arguments}} for {{chat_id}}',
    );
    await browserExpect(palette.getByRole('option', { name: /^local_ctx\b/ })).toContainText(
      'Reconnected context for {{chat_id}}',
    );
    await palette.getByRole('button', { name: 'Close', exact: true }).click();
    await palette.waitFor({ state: 'detached' });

    expandCalls = 0;
    projectResolveCalls = 0;
    await composer.fill('/s local_review');
    await composer.press('Enter');
    await browserExpect(composer).toHaveValue(`Updated open PRs for ${chatId}`);
    await composer.fill('/s local_ctx');
    await composer.press('Enter');
    await browserExpect(composer).toHaveValue(`Reconnected context for ${chatId}`);
    expect(expandCalls).toBe(0);
    expect(projectResolveCalls).toBe(0);

    phase('Phase 2: checking scheduled prompt local expansion vs project_path fallback');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
    const scheduledList = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
    await scheduledList.waitFor();
    await scheduledList.getByRole('button', { name: 'Add Prompt', exact: true }).click();
    const scheduledEditor = page.getByRole('dialog', { name: 'Add Scheduled Prompt', exact: true });
    await scheduledEditor.waitFor();
    await scheduledEditor.getByLabel('Project Path', { exact: true }).fill('.');
    const browserDismiss = page.locator('[data-slot="directory-browser-dismiss"]');
    if (await browserDismiss.isVisible()) await browserDismiss.click({ position: { x: 4, y: 4 } });
    await browserExpect(
      scheduledEditor.locator('[data-slot="project-path-field"] .text-status-success-foreground'),
    ).toBeVisible();

    const scheduledPrompt = scheduledEditor.getByRole('textbox', { name: 'Prompt', exact: true });
    expandCalls = 0;
    await scheduledEditor.getByRole('button', { name: 'Insert Snippet', exact: true }).click();
    await palette.getByRole('option', { name: /^date_review\b/ }).click();
    await browserExpect(scheduledPrompt).toHaveValue('Summary on {{current_date}}');
    expect(expandCalls).toBe(0);

    await scheduledPrompt.fill('');
    await scheduledEditor.getByRole('button', { name: 'Insert Snippet', exact: true }).click();
    await palette.getByRole('option', { name: /^manual_ctx\b/ }).click();
    await browserExpect(scheduledPrompt).toHaveValue('Context for {{chat_id}} on {{current_date}}');
    expect(expandCalls).toBe(0);

    await scheduledPrompt.fill('');
    await scheduledEditor.getByRole('button', { name: 'Insert Snippet', exact: true }).click();
    await palette.getByRole('option', { name: /^path_review\b/ }).click();
    await browserExpect(scheduledPrompt).toHaveValue(`Review in ${integration.executionDirs.project}`);
    expect(expandCalls).toBe(1);

    await scheduledEditor.getByRole('button', { name: 'Close', exact: true }).click();
    await scheduledEditor.waitFor({ state: 'detached' });
    await scheduledList.getByRole('button', { name: 'Close', exact: true }).click();
    await scheduledList.waitFor({ state: 'detached' });

    phase('Phase 3: checking HTTP 409 edit retry in Snippets manager');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Snippets', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Snippets', exact: true });
    await manager.getByRole('button', { name: 'Edit local_review', exact: true }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit Snippet', exact: true });
    const templateField = editDialog.getByRole('textbox', { name: 'Snippet text', exact: true });
    await templateField.fill('Conflict retry {{arguments}}');

    const getsBeforeConflict = snippetGetDone;
    const concurrentUpdate = await client.put<SnippetsMutationResponse>('/api/v1/snippets', {
      expectedRevision: snippetSnapshot.revision,
      id: dateReview.id,
      snippet: {
        shortName: 'date_review',
        template: 'Advanced {{current_date}}',
        defaultArguments: '',
      },
    });
    snippetSnapshot = concurrentUpdate.snapshot;
    const saveButton = editDialog.getByRole('button', { name: 'Save', exact: true });
    await browserExpect.poll(() => snippetGetDone > getsBeforeConflict, { timeout: 15_000 }).toBe(true);
    await browserExpect(saveButton).toBeEnabled();

    await fixture.withExpectedConsoleErrors(
      [/Failed to load resource: the server responded with a status of 409.*/],
      async () => {
        await saveButton.click();
        await browserExpect(editDialog.getByRole('alert')).toBeVisible();
        await browserExpect(templateField).toHaveValue('Conflict retry {{arguments}}');
      },
    );

    await browserExpect(saveButton).toBeEnabled();
    await saveButton.click();
    await editDialog.waitFor({ state: 'detached' });
    const finalSnapshot = await client.get<SnippetsSnapshot>('/api/v1/snippets');
    expect(finalSnapshot.snippets.find((entry) => entry.id === localReview.id)?.template).toBe(
      'Conflict retry {{arguments}}',
    );

    await manager.getByRole('button', { name: 'Close', exact: true }).click();
    await manager.waitFor({ state: 'detached' });
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
