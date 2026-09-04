import type { Page } from 'playwright';

// The canonical desktop layout always includes a dedicated Files window.
export async function canonicalFilesWindowId(page: Page): Promise<string> {
  const filesWindow = page.locator('[data-workspace-window-active-surface="singleton:files"]');
  if ((await filesWindow.count()) === 0) throw new Error('Missing canonical Files window.');
  const windowId = await filesWindow.getAttribute('data-workspace-window-id');
  if (!windowId) throw new Error('Missing canonical Files window.');
  return windowId;
}

// Closes the canonical Files window so geometry checks keep the
// viewport-driven workspace widths they assume.
export async function collapseCanonicalFilesWindow(page: Page): Promise<void> {
  const filesWindow = page.locator('[data-workspace-window-active-surface="singleton:files"]');
  if ((await filesWindow.count()) === 0) return;
  const windowId = await filesWindow.getAttribute('data-workspace-window-id');
  if (!windowId) return;
  await page.locator(`[data-workspace-window-close="${windowId}"]`).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspace-window-id]').length === 1,
  );
}
