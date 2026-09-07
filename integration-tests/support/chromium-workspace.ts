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

async function workspaceWindowAddAction(page: Page, label: string, windowId?: string) {
  const workspaceWindow = page.locator(
    windowId
      ? `[data-workspace-window-id="${windowId}"]`
      : '[data-workspace-window-current="true"]',
  );
  await workspaceWindow.waitFor({ state: 'visible' });
  const addControls = workspaceWindow.locator('[data-workspace-window-add-controls]');
  const inlineAction = addControls.getByRole('button', {
    name: label,
    exact: true,
  });
  if ((await inlineAction.count()) > 0) return inlineAction;

  await addControls.locator('[data-workspace-window-add-trigger]').click();
  return page.getByRole('menuitem', { name: label, exact: true });
}

export async function clickWorkspaceWindowAddAction(
  page: Page,
  label: string,
  windowId?: string,
): Promise<void> {
  await (await workspaceWindowAddAction(page, label, windowId)).click();
}

export async function waitForWorkspaceWindowAddActionEnabled(
  page: Page,
  label: string,
  windowId?: string,
): Promise<void> {
  await (await workspaceWindowAddAction(page, label, windowId)).click({ trial: true });
}
