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
  const addControls = workspaceWindow?.querySelector<HTMLElement>(
    '[data-workspace-window-add-controls]',
  );
  const inlineAction = [
    ...(addControls?.querySelectorAll<HTMLButtonElement>('[data-workspace-window-add-inline]') ??
      []),
  ].find((button) => button.getAttribute('aria-label') === expectedLabel);
  const menus = [
    ...document.querySelectorAll<HTMLElement>('[data-workspace-window-add-menu]'),
  ].filter(
    (element) =>
      element.dataset.workspaceWindowAddMenu === workspaceWindow?.dataset.workspaceWindowId &&
      element.dataset.state === 'open',
  );
  const menuAction = menus
    .flatMap((menu) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')])
    .find(
      (element) =>
        (element.getAttribute('aria-label') || element.textContent?.trim()) === expectedLabel,
    );
  const action = inlineAction ?? menuAction;
  // Views that live in a titlebar group menu rather than in the add menu itself.
  const viewGroup = ({
    'Open Chat Map': 'chat-views',
    'Open Canvas': 'chat-views',
    'Open Chat Board': 'chat-views',
    'Open Pull Requests': 'github-views',
  } as Record<string, string>)[expectedLabel];
  const groupTrigger = viewGroup
    ? addControls?.querySelector<HTMLButtonElement>(
        `[data-workspace-window-add-group-trigger="${viewGroup}"]`,
      )
    : null;
  const trigger =
    groupTrigger ??
    addControls?.querySelector<HTMLButtonElement>('[data-workspace-window-add-trigger]') ??
    addControls?.querySelector<HTMLButtonElement>('[data-workspace-window-add-terminal-trigger]');

  if (
    expectedIntent === 'observe' &&
    trigger?.dataset.workspaceWindowAddObserveClosing === expectedLabel
  ) {
    if (menus.length > 0) return false;
    delete trigger.dataset.workspaceWindowAddObserveClosing;
    return true;
  }

  if (action) {
    if (
      (action instanceof HTMLButtonElement && action.disabled) ||
      action.getAttribute('aria-disabled') === 'true'
    ) {
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

  if (trigger?.getAttribute('aria-expanded') !== 'true') {
    trigger?.click();
  } else if (viewGroup) {
    const submenuTrigger = menus
      .flatMap((menu) => [
        ...menu.querySelectorAll<HTMLElement>(`[data-workspace-window-add-action="${viewGroup}"]`),
      ])
      .find((element) => element.getAttribute('aria-expanded') !== 'true');
    submenuTrigger?.click();
  }
  return false;
}
