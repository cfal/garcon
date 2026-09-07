import type { Page } from 'playwright';

// The canonical desktop layout always includes a dedicated Files window.
export async function canonicalFilesWindowId(page: Page): Promise<string> {
  const filesWindow = page.locator('[data-workspace-window-active-surface="singleton:files"]');
  await filesWindow.waitFor({ state: 'visible' });
  const windowId = await filesWindow.getAttribute('data-workspace-window-id');
  if (!windowId) throw new Error('Missing canonical Files window.');
  return windowId;
}

// Closes the canonical Files window so geometry checks keep the
// viewport-driven workspace widths they assume.
export async function collapseCanonicalFilesWindow(page: Page): Promise<void> {
  const windowId = await canonicalFilesWindowId(page);
  const windowCount = await page.locator('[data-workspace-window-id]').count();
  await page.locator(`[data-workspace-window-close="${windowId}"]`).click();
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelectorAll('[data-workspace-window-id]').length === expectedCount,
    windowCount - 1,
  );
}

export async function clickWorkspaceWindowAddAction(
  page: Page,
  label: string,
  windowId?: string,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedLabel, expectedWindowId }) => {
      const workspaceWindow = expectedWindowId
        ? [...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]')].find(
            (element) => element.dataset.workspaceWindowId === expectedWindowId,
          )
        : document.querySelector<HTMLElement>('[data-workspace-window-current="true"]');
      const addControls = workspaceWindow?.querySelector<HTMLElement>(
        '[data-workspace-window-add-controls]',
      );
      const inlineAction = [
        ...(addControls?.querySelectorAll<HTMLButtonElement>(
          '[data-workspace-window-add-inline]',
        ) ?? []),
      ].find((button) => button.getAttribute('aria-label') === expectedLabel);
      const menu = [
        ...document.querySelectorAll<HTMLElement>('[data-workspace-window-add-menu]'),
      ].find(
        (element) =>
          element.dataset.workspaceWindowAddMenu === workspaceWindow?.dataset.workspaceWindowId,
      );
      const menuAction = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find(
        (element) =>
          (element.getAttribute('aria-label') || element.textContent?.trim()) === expectedLabel,
      );
      const action = inlineAction ?? menuAction;

      if (action) {
        if (
          (action instanceof HTMLButtonElement && action.disabled) ||
          action.getAttribute('aria-disabled') === 'true'
        ) {
          return false;
        }
        action.click();
        return true;
      }

      const trigger = addControls?.querySelector<HTMLButtonElement>(
        '[data-workspace-window-add-trigger]',
      );
      if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click();
      return false;
    },
    { expectedLabel: label, expectedWindowId: windowId },
    { timeout: 20_000 },
  );
}
