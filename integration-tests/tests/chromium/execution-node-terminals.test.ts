import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import type { TerminalListResponse } from '../../../common/terminal.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction } from '../../support/chromium-workspace.js';

test('remote terminals keep their renderer and job through host reconnect and responsive moves', async () => {
  await withChromiumFixture('execution-node-terminals', async ({ page, integration, browserErrors, assertNoBrowserErrors }, markPhase) => {
    const { client, directAgents, executionDirs } = integration;
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({ chatId, projectPath: executionDirs.project, content: 'Synthetic terminal context', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const events: Array<{ type: string; data?: string; terminal?: { terminalId: string } }> = [];
    page.on('websocket', socket => socket.on('framereceived', frame => {
      try { events.push(JSON.parse(String(frame.payload))); } catch { /* Ignores non-JSON browser frames. */ }
    }));
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await browserExpect(page.getByRole('button', { name: 'Execution node: Integration worker', exact: true })).toBeVisible();
    await clickWorkspaceWindowAddAction(page, 'New Terminal');
    await page.getByRole('menuitem', { name: 'Integration worker', exact: true }).click();
    const input = page.locator('.xterm-helper-textarea');
    await input.focus();
    await page.keyboard.type('export TERMINAL_BROWSER_VALUE=retained; printf "terminal-browser-ready\\n"');
    await page.keyboard.press('Enter');
    await browserExpect.poll(() => events.filter(item => item.type === 'terminal-output').map(item => item.data ?? '').join('')).toContain('terminal-browser-ready');
    const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${client.nodeId}`);
    const terminal = inventory.terminals[0]!;
    const surface = page.locator(`[data-workspace-surface-id="terminal:${terminal.terminalId}"]`);
    await surface.locator('.xterm').evaluate(element => element.setAttribute('data-retained-terminal', 'synthetic-renderer'));
    const artifactDirectory = join(import.meta.dir, '../../artifacts/chromium');
    await mkdir(artifactDirectory, { recursive: true });
    await page.screenshot({ path: join(artifactDirectory, 'terminal-hosts-desktop.png') });

    markPhase('reconnecting the same worker without replacing browser WebSocket or PTY');
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: false });
    await browserExpect(surface.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    const previousAttachments = events.filter(item => item.type === 'terminal-attached').length;
    let rejectedInventory = false;
    await page.route(`**/api/v1/terminals?nodeId=${client.nodeId}`, async route => {
      if (rejectedInventory) return route.continue();
      rejectedInventory = true;
      await route.fulfill({ status: 503, json: { success: false, error: 'Synthetic inventory interruption', code: 'terminal-unavailable' } });
    });
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: true });
    await browserExpect.poll(() => events.filter(item => item.type === 'terminal-attached').length, { timeout: 15_000 }).toBeGreaterThan(previousAttachments);
    expect(rejectedInventory).toBe(true);
    await page.unroute(`**/api/v1/terminals?nodeId=${client.nodeId}`);
    const expectedError = browserErrors.findIndex(error => error.includes('503 (Service Unavailable)'));
    expect(expectedError).toBeGreaterThanOrEqual(0);
    browserErrors.splice(expectedError, 1);
    await browserExpect(surface.locator('[data-retained-terminal="synthetic-renderer"]')).toHaveCount(1);
    expect((await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${client.nodeId}`)).terminals[0]?.terminalId).toBe(terminal.terminalId);
    await input.focus();
    await page.keyboard.type('printf "job-%s\\n" "$TERMINAL_BROWSER_VALUE"');
    await page.keyboard.press('Enter');
    await browserExpect.poll(() => events.filter(item => item.type === 'terminal-output').map(item => item.data ?? '').join('')).toContain('job-retained');

    markPhase('moving the same renderer to mobile and choosing Local');
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect(surface.locator('[data-retained-terminal="synthetic-renderer"]')).toBeVisible();
    const mobilePicker = page.locator('.mobile-shell select[aria-label="Terminal session"]');
    const pickerBounds = await mobilePicker.boundingBox();
    expect(pickerBounds?.width).toBeGreaterThanOrEqual(170);

    markPhase('updating host and terminal labels without replacing the renderer');
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { label: 'Renamed worker' });
    await browserExpect(mobilePicker).toHaveAttribute('title', `Renamed worker ${terminal.displaySequence} - Renamed worker: ${terminal.initialWorkingDirectory} - Attached`);
    await client.patch('/api/v1/terminals', { terminalId: terminal.terminalId, title: 'Build logs' });
    await browserExpect(mobilePicker).toHaveAttribute('title', `Build logs - Renamed worker: ${terminal.initialWorkingDirectory} - Attached`);
    await client.patch('/api/v1/terminals', { terminalId: terminal.terminalId, title: null });
    await browserExpect(mobilePicker).toHaveAttribute('title', `Renamed worker ${terminal.displaySequence} - Renamed worker: ${terminal.initialWorkingDirectory} - Attached`);
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { label: 'Integration worker' });
    await browserExpect(mobilePicker).toHaveAttribute('title', `Integration worker ${terminal.displaySequence} - Integration worker: ${terminal.initialWorkingDirectory} - Attached`);
    await browserExpect(surface.locator('[data-retained-terminal="synthetic-renderer"]')).toHaveCount(1);

    markPhase('taking over the mobile terminal and choosing Local');
    const takeoverInventory = await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${client.nodeId}`);
    client.sendTerminal({ type: 'terminal-attach', terminalId: terminal.terminalId, attachmentId: crypto.randomUUID(), attachmentEpoch: takeoverInventory.attachmentEpoch, clientId: 'synthetic-takeover-browser', afterSequence: 0, intent: 'takeover' });
    await browserExpect(mobilePicker).toHaveAttribute('title', /Taken over/);
    const create = page.locator('.mobile-shell').getByRole('button', { name: 'New Terminal', exact: true });
    await create.focus();
    await page.keyboard.press('Enter');
    await browserExpect(page.getByRole('menuitem', { name: 'Local', exact: true })).toBeVisible();
    await page.screenshot({ path: join(artifactDirectory, 'terminal-hosts-mobile.png') });
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: false });
    await browserExpect(page.getByRole('menuitem', { name: /Integration worker/ })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await browserExpect(create).toBeFocused();
    await browserExpect(create).toHaveAttribute('aria-disabled', 'true');
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: true });
    await browserExpect(create).not.toHaveAttribute('aria-disabled', 'true');
    expect((await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${client.nodeId}`)).terminals).toHaveLength(1);
    await create.click();
    await page.getByRole('menuitem', { name: 'Local', exact: true }).click();
    await browserExpect(page.locator('.mobile-shell select[aria-label="Terminal session"]')).toContainText('Local 1');
    const local = await client.get<TerminalListResponse>('/api/v1/terminals?nodeId=local');
    expect(local.terminals[0]?.initialWorkingDirectory).toBe(integration.dirs.project);
    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${client.nodeId}`)).terminals[0]?.processStatus).toBe('running');
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'separate', serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } });
}, 120_000);
