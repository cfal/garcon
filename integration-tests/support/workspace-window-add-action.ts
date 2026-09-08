export type WorkspaceWindowAddActionIntent = 'activate' | 'observe';

export interface WorkspaceWindowAddActionRequest {
  expectedLabel: string;
  expectedWindowId?: string;
  expectedIntent: WorkspaceWindowAddActionIntent;
}

export function interactWithWorkspaceWindowAddAction({
  expectedLabel,
  expectedWindowId,
  expectedIntent,
}: WorkspaceWindowAddActionRequest): boolean {
  const workspaceWindow = expectedWindowId
    ? [...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]')].find(
        (element) => element.dataset.workspaceWindowId === expectedWindowId,
      )
    : document.querySelector<HTMLElement>('[data-workspace-window-current="true"]');
  const addControls = workspaceWindow?.querySelector<HTMLElement>('[data-workspace-window-add-controls]');
  const inlineAction = [
    ...(addControls?.querySelectorAll<HTMLButtonElement>('[data-workspace-window-add-inline]') ?? []),
  ].find((button) => button.getAttribute('aria-label') === expectedLabel);
  const menu = [...document.querySelectorAll<HTMLElement>('[data-workspace-window-add-menu]')].find(
    (element) =>
      element.dataset.workspaceWindowAddMenu === workspaceWindow?.dataset.workspaceWindowId &&
      element.dataset.state === 'open',
  );
  const menuAction = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find(
    (element) => (element.getAttribute('aria-label') || element.textContent?.trim()) === expectedLabel,
  );
  const action = inlineAction ?? menuAction;
  const trigger =
    addControls?.querySelector<HTMLButtonElement>('[data-workspace-window-add-trigger]') ??
    addControls?.querySelector<HTMLButtonElement>('[data-workspace-window-add-terminal-trigger]');

  if (
    expectedIntent === 'observe' &&
    trigger?.dataset.workspaceWindowAddObserveClosing === expectedLabel
  ) {
    if (menu) return false;
    delete trigger.dataset.workspaceWindowAddObserveClosing;
    return true;
  }

  if (action) {
    if ((action instanceof HTMLButtonElement && action.disabled) || action.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    if (expectedIntent === 'activate') {
      action.click();
    } else if (trigger?.getAttribute('aria-expanded') === 'true') {
      trigger.dataset.workspaceWindowAddObserveClosing = expectedLabel;
      trigger.click();
      return false;
    }
    return true;
  }

  if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click();
  return false;
}
