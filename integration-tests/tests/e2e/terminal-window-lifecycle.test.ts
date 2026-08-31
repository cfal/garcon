import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import type { TerminalListResponse } from '../../../common/terminal.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda terminal window lifecycle', () => {
  test('offers terminal actions and deletes an exited terminal when its tab closes', async () => {
    await withE2eFixture(
      'terminal-window-lifecycle',
      async (fixture) => {
        const app = new SpaDriver(fixture.page, fixture.integration);
        await app.setViewport(1_440, 900);
        await app.open();
        await fixture.waitForSpaWebSocket();
        await app.startOpenAiDirectChat('terminal-window-lifecycle');
        const windowId = await app.currentWorkspaceWindowId();

        await app.selectWorkspaceWindowSurface('New Terminal', windowId);
        const terminalId = await activeTerminalId(fixture.page, windowId);
        await waitForExitedTerminal(fixture.page, terminalId);
        await waitForPersistedTerminalPlacement(fixture.page, terminalId);

        expect(
          await fixture.integration.client.get<TerminalListResponse>('/api/v1/terminals'),
        ).toMatchObject({
          success: true,
          terminals: [{ terminalId, title: null, processStatus: 'exited', exitCode: 0 }],
        });
        expect(
          await fixture.page.$(
            `[data-workspace-surface-id="terminal:${terminalId}"] .surface-toolbar`,
          ),
        ).toBeNull();

        await app.openWorkspaceWindowActions(windowId);
        const menuItems = await fixture.page.$eval(
          `[data-workspace-window-menu="${windowId}"]`,
          (menu) =>
            [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
              (item) => item.textContent?.trim() ?? '',
            ),
        );
        expect(menuItems).toContain('Paste into terminal');
        expect(menuItems).toContain('Rename');
        expect(menuItems.some((item) => item.startsWith('Font size'))).toBe(true);
        expect(menuItems).toContain('Terminate');
        expect(menuItems).toContain('Close tab');
        expect(menuItems).not.toContain('New Terminal');

        await app.clickMenuItem('Rename');
        await app.fill('input[aria-label="Terminal name"]', 'Build logs');
        await app.clickButton('Save');
        await fixture.page.waitForFunction(
          (expectedWindowId, expectedTerminalId) =>
            document
              .getElementById(`${expectedWindowId}-tab-terminal:${expectedTerminalId}`)
              ?.getAttribute('aria-label') === 'Build logs',
          { timeout: 20_000 },
          windowId,
          terminalId,
        );
        expect(
          await fixture.integration.client.get<TerminalListResponse>('/api/v1/terminals'),
        ).toMatchObject({
          success: true,
          terminals: [{ terminalId, title: 'Build logs' }],
        });

        await app.openWorkspaceWindowActions(windowId);
        await app.clickMenuItem('Close tab');
        await waitForTerminatedTerminal(fixture.page, terminalId);
        await waitForPersistedTerminalRemoval(fixture.page, terminalId);

        expect(
          await fixture.integration.client.get<TerminalListResponse>('/api/v1/terminals'),
        ).toEqual({ success: true, terminals: [] });
        expect(
          await fixture.page.$(`[data-workspace-surface-id="terminal:${terminalId}"]`),
        ).toBeNull();
        fixture.assertNoBrowserErrors();
      },
      { serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/true' } },
    );
  });
});

async function activeTerminalId(page: Page, windowId: string): Promise<string> {
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector<HTMLElement>(`[data-workspace-window-id="${expectedWindowId}"]`)
        ?.dataset.workspaceWindowActiveSurface?.startsWith('terminal:') === true,
    { timeout: 20_000 },
    windowId,
  );
  return page.$eval(`[data-workspace-window-id="${windowId}"]`, (workspaceWindow) => {
    const surfaceId = (workspaceWindow as HTMLElement).dataset.workspaceWindowActiveSurface;
    if (!surfaceId?.startsWith('terminal:')) throw new Error('Terminal surface is not active.');
    return surfaceId.slice('terminal:'.length);
  });
}

async function waitForExitedTerminal(page: Page, terminalId: string): Promise<void> {
  await page.waitForFunction(
    (expectedTerminalId) => {
      const scope = globalThis as typeof globalThis & {
        __garconSpaWsEvents?: unknown[];
      };
      return (scope.__garconSpaWsEvents ?? []).some((event) => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
        const record = event as {
          type?: unknown;
          terminal?: { terminalId?: unknown; processStatus?: unknown };
        };
        return (
          (record.type === 'terminal-attached' || record.type === 'terminal-status') &&
          record.terminal?.terminalId === expectedTerminalId &&
          record.terminal.processStatus === 'exited'
        );
      });
    },
    { timeout: 20_000 },
    terminalId,
  );
}

async function waitForTerminatedTerminal(page: Page, terminalId: string): Promise<void> {
  await page.waitForFunction(
    (expectedTerminalId) => {
      const scope = globalThis as typeof globalThis & {
        __garconSpaWsEvents?: unknown[];
      };
      return (scope.__garconSpaWsEvents ?? []).some((event) => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
        const record = event as { type?: unknown; terminalId?: unknown };
        return record.type === 'terminal-terminated' && record.terminalId === expectedTerminalId;
      });
    },
    { timeout: 20_000 },
    terminalId,
  );
}

async function waitForPersistedTerminalPlacement(page: Page, terminalId: string): Promise<void> {
  await page.waitForFunction(
    (expectedTerminalId) => {
      const raw = localStorage.getItem('workspace_layout_v2');
      if (!raw) return false;
      const parsed = JSON.parse(raw) as {
        root?: unknown;
        unplacedTerminalIds?: unknown;
      };
      return (
        JSON.stringify(parsed.root).includes(`"terminalId":"${expectedTerminalId}"`) &&
        Array.isArray(parsed.unplacedTerminalIds) &&
        !parsed.unplacedTerminalIds.includes(expectedTerminalId)
      );
    },
    { timeout: 20_000 },
    terminalId,
  );
}

async function waitForPersistedTerminalRemoval(page: Page, terminalId: string): Promise<void> {
  await page.waitForFunction(
    (expectedTerminalId) => {
      const raw = localStorage.getItem('workspace_layout_v2');
      if (!raw) return false;
      const parsed = JSON.parse(raw) as {
        root?: unknown;
        unplacedTerminalIds?: unknown;
      };
      return (
        !JSON.stringify(parsed.root).includes(`"terminalId":"${expectedTerminalId}"`) &&
        Array.isArray(parsed.unplacedTerminalIds) &&
        !parsed.unplacedTerminalIds.includes(expectedTerminalId)
      );
    },
    { timeout: 20_000 },
    terminalId,
  );
}
