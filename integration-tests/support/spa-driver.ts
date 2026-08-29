import type { Page } from 'puppeteer-core';
import type { RecordedAnthropicRequest } from './fake-anthropic-server.js';
import type { RecordedCompletionRequest } from './fake-openai-server.js';
import type { IntegrationFixture } from './integration-fixture.js';

interface ClickOptions {
  contains?: boolean;
  last?: boolean;
}

interface ResponsiveActionClickOptions {
  within?: string;
}

type QueueRowAction = 'Edit queued message' | 'Remove from queue';
type QueueMoveDirection = 'up' | 'down';
type ComposerAction = 'Send message' | 'Queue message';

export class SpaDriver {
  readonly #page: Page;
  readonly #integration: IntegrationFixture;

  constructor(page: Page, integration: IntegrationFixture) {
    this.#page = page;
    this.#integration = integration;
  }

  async open(): Promise<void> {
    await this.#openUrl(this.#integration.garcon.baseUrl);
  }

  async openChat(chatId: string): Promise<void> {
    await this.#openUrl(`${this.#integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`);
    await this.waitForSelectedChat(chatId);
  }

  async #openUrl(url: string): Promise<void> {
    const response = await this.#page.goto(url, {
      // Lightpanda 0.3.5 executes the document but does not consistently report
      // DOMContentLoaded over CDP. The rendered control is the readiness boundary.
      waitUntil: [],
    });
    if (!response?.ok()) throw new Error(`SPA navigation failed with status ${response?.status()}`);
    await this.#page.waitForFunction(() => document.querySelector('button') !== null);
  }

  async startOpenAiDirectChat(
    content: string,
    options: { projectPath?: string } = {},
  ): Promise<RecordedCompletionRequest> {
    return this.#startDirectChat({
      content,
      projectPath: options.projectPath,
      selectedAgentLabel: 'Direct (Chat Completions)',
      optionAgentLabel: 'Chat Completions',
      modelLabel: 'Integration Echo',
      waitForRequest: () =>
        this.#integration.fakeProviders.openAi.waitForRequest(
          { lastUserText: content },
          { timeoutMs: 20_000 },
        ),
    });
  }

  async startAnthropicDirectChat(content: string): Promise<RecordedAnthropicRequest> {
    return this.#startDirectChat({
      content,
      selectedAgentLabel: 'Direct (Anthropic)',
      optionAgentLabel: 'Anthropic',
      modelLabel: 'Integration Anthropic Echo',
      waitForRequest: () =>
        this.#integration.fakeProviders.anthropic.waitForRequest(
          { lastUserText: content },
          { timeoutMs: 20_000 },
        ),
    });
  }

  async ensureDirectModelSelected(input: {
    selectedAgentLabel: string;
    optionAgentLabel: string;
    modelLabel: string;
  }): Promise<void> {
    const directProviderSelected = await this.#page.evaluate(
      ({ selectedAgentLabel, modelLabel }) => {
        const dialog = document.querySelector('[role="dialog"]');
        return [...(dialog?.querySelectorAll('button') ?? [])].some((element) => {
          const name = element.getAttribute('aria-label') || element.textContent?.trim() || '';
          return name.includes(selectedAgentLabel) && name.includes(modelLabel);
        });
      },
      {
        selectedAgentLabel: input.selectedAgentLabel,
        modelLabel: input.modelLabel,
      },
    );
    if (directProviderSelected) return;

    await this.#clickNewChatModelSelector();
    await this.waitForButton(input.optionAgentLabel, { timeout: 30_000 });
    await this.clickButton(input.optionAgentLabel);
    await this.waitForButton(input.modelLabel, { timeout: 30_000 });
    await this.clickButton(input.modelLabel);
  }

  async #startDirectChat<TRequest>(input: {
    content: string;
    projectPath?: string;
    selectedAgentLabel: string;
    optionAgentLabel: string;
    modelLabel: string;
    waitForRequest: () => Promise<TRequest>;
  }): Promise<TRequest> {
    await this.clickButton('New Chat');
    await this.#page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"]');
        return (
          dialog !== null &&
          dialog.querySelector('[role="status"][aria-label="Loading chat defaults..."]') === null
        );
      },
      { timeout: 20_000 },
    );
    await this.#page.waitForFunction(
      () =>
        document.activeElement?.matches(
          '[role="dialog"] textarea[placeholder="How can I help you today?"]',
        ) === true,
      { timeout: 20_000 },
    );
    await this.ensureDirectModelSelected(input);

    const requestedProjectPath = input.projectPath ?? this.#integration.dirs.project;
    const projectPath = await this.#page.$eval(
      '[role="dialog"] input[aria-label="Project Path"]',
      (element) => (element as HTMLInputElement).value,
    );
    if (projectPath !== requestedProjectPath) {
      await this.fill('[role="dialog"] input[aria-label="Project Path"]', requestedProjectPath);
    }
    await this.fill(
      '[role="dialog"] textarea[placeholder="How can I help you today?"]',
      input.content,
    );
    await this.waitForDialogButtonEnabled('Start session');
    await this.clickButton('Start session');
    const request = await input.waitForRequest();
    await this.#page.waitForFunction(() => document.querySelector('[role="dialog"]') === null, {
      timeout: 20_000,
    });
    await this.#page.waitForFunction(
      () => {
        const composer = document.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="Reply..."]',
        );
        return composer !== null && !composer.disabled && document.activeElement === composer;
      },
      { timeout: 20_000 },
    );
    return request;
  }

  async #clickNewChatModelSelector(): Promise<void> {
    await this.#page.waitForFunction(
      () => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const button = dialog
          ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
              (element.getAttribute('aria-label') ?? '').includes(' / '),
            )
          : null;
        return button !== null && button !== undefined && !button.disabled;
      },
      { timeout: 20_000 },
    );
    await this.#page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const button = dialog
        ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
            (element.getAttribute('aria-label') ?? '').includes(' / '),
          )
        : null;
      if (!button) throw new Error('Missing new chat model selector.');
      if (button.disabled) throw new Error('New chat model selector is disabled.');
      button.click();
    });
  }

  async openChatSearch(): Promise<void> {
    await this.clickButton('Search chats...');
    await this.#page.waitForSelector('input[placeholder="Search chats..."]');
  }

  async searchChats(query: string): Promise<void> {
    await this.fill('input[placeholder="Search chats..."]', query);
  }

  async applySidebarSearch(query: string, chatId: string): Promise<void> {
    const chat = (await this.#integration.client.listChats()).sessions.find(
      (entry) => entry.id === chatId,
    );
    if (!chat) throw new Error(`Missing chat for sidebar search: ${chatId}`);
    await this.openChatSearch();
    await this.searchChats(query);
    await this.#page.waitForFunction(
      (title) =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-slot="search-dialog-results"] [role="option"]',
          ),
        ].some((row) => row.innerText.includes(title)),
      { timeout: 20_000 },
      chat.title,
    );
    await this.#page.evaluate((title) => {
      const option = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-slot="search-dialog-results"] [role="option"]',
        ),
      ].find((row) => row.innerText.includes(title));
      if (!option) throw new Error(`Missing sidebar search result: ${title}`);
      option.click();
    }, chat.title);
    await this.waitForSelectedChat(chatId);
    await this.#page.waitForSelector('[data-slot="active-search-banner"]');
  }

  async clearSidebarSearch(): Promise<void> {
    await this.#page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>('[data-slot="active-search-banner"]');
      const button = [...(banner?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (element) => (element.getAttribute('aria-label') ?? '') === 'Clear search',
      );
      if (!button) throw new Error('Missing Clear search button.');
      button.click();
    });
    await this.#page.waitForFunction(
      () => document.querySelector('[data-slot="active-search-banner"]') === null,
      { timeout: 20_000 },
    );
  }

  async setRecentActivitySort(enabled: boolean): Promise<void> {
    const isActive = await this.#page.evaluate(
      () => document.querySelector('[data-slot="sidebar-sort-indicator"]') !== null,
    );
    if (isActive !== enabled) {
      await this.clickButton('More actions');
      await this.#page.waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].some(
            (element) =>
              (element.getAttribute('aria-label') || element.textContent?.trim()) ===
              'Sort by recent activity',
          ),
        { timeout: 20_000 },
      );
      await this.#page.evaluate(() => {
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
          (element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) ===
            'Sort by recent activity',
        );
        if (!item) throw new Error('Missing Sort by recent activity menu item.');
        item.click();
      });
    }
    await this.#page.waitForFunction(
      (expected) =>
        (document.querySelector('[data-slot="sidebar-sort-indicator"]') !== null) === expected,
      { timeout: 20_000 },
      enabled,
    );
  }

  async sidebarChatIds(list: 'pinned' | 'normal' | 'archived'): Promise<string[]> {
    return this.#page.$$eval(
      `[data-sidebar-virtual-row][data-sidebar-virtual-list-row="${list}"]`,
      (rows) => rows.map((row) => (row as HTMLElement).dataset.sidebarVirtualRow ?? ''),
    );
  }

  async waitForSidebarChatIds(
    list: 'pinned' | 'normal' | 'archived',
    expected: string[],
  ): Promise<void> {
    await this.#page.waitForFunction(
      ({ list, expected }) => {
        const actual = [
          ...document.querySelectorAll<HTMLElement>(
            `[data-sidebar-virtual-row][data-sidebar-virtual-list-row="${list}"]`,
          ),
        ].map((row) => row.dataset.sidebarVirtualRow ?? '');
        return (
          actual.length === expected.length &&
          actual.every((chatId, index) => chatId === expected[index])
        );
      },
      { timeout: 20_000 },
      { list, expected },
    );
  }

  async waitForLocalNotice(text: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => {
        const feed = document.querySelector('[data-chat-scroll-viewport]');
        return [...(feed?.querySelectorAll<HTMLElement>('span') ?? [])].some(
          (element) => element.textContent?.trim() === expected,
        );
      },
      { timeout: 20_000 },
      text,
    );
  }

  async waitForTranscriptSearchResult(input: { count: number; snippet: string }): Promise<void> {
    await this.#page.waitForFunction(
      ({ count, snippet }) => {
        const rows = [
          ...document.querySelectorAll('[data-slot="search-dialog-results"] [role="option"]'),
        ];
        return rows.length === count && rows.some((row) => row.textContent?.includes(snippet));
      },
      { timeout: 20_000 },
      input,
    );
  }

  async chatSearchResultCount(): Promise<number> {
    return this.#page.$$eval(
      '[data-slot="search-dialog-results"] [role="option"]',
      (rows) => rows.length,
    );
  }

  async chatSearchResultsText(): Promise<string> {
    return this.#page.$eval(
      '[data-slot="search-dialog-results"]',
      (element) => (element as HTMLElement).innerText,
    );
  }

  async sendComposer(content: string): Promise<void> {
    await this.fill('textarea[placeholder="Reply..."]', content);
    const title = await this.#page
      .waitForFunction(
        () => {
          const button = [...document.querySelectorAll('button')].find((element) => {
            const name = element.getAttribute('aria-label') || element.textContent?.trim();
            return (
              (name === 'Send message' || name === 'Queue message') &&
              !(element as HTMLButtonElement).disabled
            );
          });
          return button?.getAttribute('aria-label') || button?.textContent?.trim() || null;
        },
        { timeout: 20_000 },
      )
      .then((handle) => handle.jsonValue());
    if (typeof title !== 'string')
      throw new Error('Composer send action did not become available.');
    await this.clickButton(title);
  }

  async waitForComposerAction(action: ComposerAction): Promise<void> {
    await this.#page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('button')].some((element) => {
          const name = element.getAttribute('aria-label') || element.textContent?.trim();
          return !element.closest('[aria-hidden="true"]') && name === expected;
        }),
      { timeout: 20_000 },
      action,
    );
  }

  async submitComposerWithEnter(content: string, expectedAction: ComposerAction): Promise<void> {
    const selector = 'textarea[placeholder="Reply..."]';
    await this.fill(selector, content);
    await this.#page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('button')].some((element) => {
          const name = element.getAttribute('aria-label') || element.textContent?.trim();
          return (
            !element.closest('[aria-hidden="true"]') &&
            name === expected &&
            !(element as HTMLButtonElement).disabled
          );
        }),
      { timeout: 20_000 },
      expectedAction,
    );
    await this.#page.$eval(selector, (element) => {
      (element as HTMLTextAreaElement).focus();
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.#page.$eval(
      selector,
      (element, nextValue) => {
        const input = element as HTMLInputElement | HTMLTextAreaElement;
        const prototype =
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, nextValue);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      value,
    );
  }

  async clickButton(name: string, options: ClickOptions = {}): Promise<void> {
    try {
      await this.#page.evaluate(
        ({ name, contains, last }) => {
          const buttons = [...document.querySelectorAll('button')].filter((element) => {
            if (element.closest('[aria-hidden="true"]')) return false;
            const accessibleName =
              element.getAttribute('aria-label') || element.textContent?.trim() || '';
            return contains ? accessibleName.includes(name) : accessibleName === name;
          });
          const button = (last ? buttons.at(-1) : buttons[0]) as HTMLButtonElement | undefined;
          if (!button) throw new Error(`Missing button: ${name}`);
          if (button.disabled) throw new Error(`Button is disabled: ${name}`);
          button.click();
        },
        {
          name,
          contains: options.contains === true,
          last: options.last === true,
        },
      );
    } catch (error) {
      // Lightpanda may collect the CDP evaluation promise when a click replaces
      // the document. The next positive product milestone still verifies it.
      if (!(error instanceof Error) || !error.message.includes('Promise was collected'))
        throw error;
    }
  }

  async workspaceWindowIds(): Promise<string[]> {
    return this.#page.$$eval('[data-workspace-window-id]', (elements) =>
      elements
        .map((element) => element.getAttribute('data-workspace-window-id'))
        .filter((id): id is string => id !== null),
    );
  }

  async waitForWorkspaceWindowCount(expected: number): Promise<void> {
    await this.#page.waitForFunction(
      (count) => document.querySelectorAll('[data-workspace-window-id]').length === count,
      { timeout: 20_000 },
      expected,
    );
  }

  async currentWorkspaceWindowId(): Promise<string> {
    return this.#page.$eval('[data-workspace-window-current="true"]', (element) => {
      const id = element.getAttribute('data-workspace-window-id');
      if (!id) throw new Error('Current workspace window has no ID.');
      return id;
    });
  }

  async focusWorkspaceWindow(windowId: string): Promise<void> {
    await this.#page.evaluate((expectedWindowId) => {
      const workspaceWindow = [
        ...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]'),
      ].find((element) => element.dataset.workspaceWindowId === expectedWindowId);
      const focusTarget = workspaceWindow?.querySelector<HTMLElement>(
        '[data-workspace-window-titlebar]',
      );
      if (!focusTarget) throw new Error(`Missing workspace window: ${expectedWindowId}`);
      focusTarget.focus();
    }, windowId);
    await this.#page.waitForFunction(
      (expectedWindowId) =>
        document
          .querySelector('[data-workspace-window-current="true"]')
          ?.getAttribute('data-workspace-window-id') === expectedWindowId,
      { timeout: 20_000 },
      windowId,
    );
  }

  async workspaceWindowIdForSurface(surfaceId: string): Promise<string> {
    return this.#page.evaluate((expectedSurfaceId) => {
      const workspaceWindow = [
        ...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]'),
      ].find((element) => {
        if (element.dataset.workspaceWindowActiveSurface === expectedSurfaceId) return true;
        return [...element.querySelectorAll<HTMLElement>('[data-window-tab-measure-id]')].some(
          (tab) => tab.dataset.windowTabMeasureId === expectedSurfaceId,
        );
      });
      const id = workspaceWindow?.dataset.workspaceWindowId;
      if (!id) throw new Error(`Missing workspace surface: ${expectedSurfaceId}`);
      return id;
    }, surfaceId);
  }

  async openNewWorkspaceWindow(name: string): Promise<void> {
    await this.#page.evaluate(() => {
      const trigger = document.querySelector<HTMLButtonElement>('[data-workspace-new-window-menu]');
      if (!trigger) throw new Error('Missing new workspace window menu.');
      if (trigger.disabled) throw new Error('New workspace window menu is disabled.');
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    });
    await this.waitForMenuItemEnabled(name);
    await this.clickMenuItem(name);
  }

  async selectWorkspaceWindowSurface(name: string, windowId?: string): Promise<void> {
    const targetWindowId = windowId ?? (await this.currentWorkspaceWindowId());
    const surfaceId = await this.#page.evaluate(
      ({ expectedName, expectedWindowId }) => {
        const workspaceWindow = [
          ...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]'),
        ].find((element) => element.dataset.workspaceWindowId === expectedWindowId);
        if (!workspaceWindow) throw new Error(`Missing workspace window: ${expectedWindowId}`);

        const measuredTab = [
          ...workspaceWindow.querySelectorAll<HTMLElement>('[data-window-tab-measure-id]'),
        ].find(
          (element) =>
            (element.getAttribute('aria-label') ||
              element.getAttribute('title') ||
              element.textContent?.trim() ||
              '') === expectedName,
        );
        if (measuredTab?.dataset.windowTabMeasureId) return measuredTab.dataset.windowTabMeasureId;

        const activeTitle = [
          ...workspaceWindow.querySelectorAll<HTMLElement>('[data-workspace-window-titlebar] span'),
        ].some((element) => element.textContent?.trim() === expectedName);
        return activeTitle ? (workspaceWindow.dataset.workspaceWindowActiveSurface ?? null) : null;
      },
      { expectedName: name, expectedWindowId: targetWindowId },
    );

    if (surfaceId) {
      await this.selectWorkspaceWindowSurfaceById(surfaceId, targetWindowId);
      return;
    }
    await this.openWorkspaceWindowAddMenu(targetWindowId);
    await this.waitForMenuItemEnabled(name);
    await this.clickMenuItem(name);
  }

  async selectWorkspaceWindowSurfaceById(surfaceId: string, windowId?: string): Promise<void> {
    const targetWindowId = windowId ?? (await this.workspaceWindowIdForSurface(surfaceId));
    const result = await this.#page.evaluate(
      ({ expectedSurfaceId, expectedWindowId }) => {
        const workspaceWindow = [
          ...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]'),
        ].find((element) => element.dataset.workspaceWindowId === expectedWindowId);
        if (!workspaceWindow) return 'missing-window';
        if (workspaceWindow.dataset.workspaceWindowActiveSurface === expectedSurfaceId) {
          const panel = document.getElementById(`${expectedWindowId}-panel-${expectedSurfaceId}`);
          if (panel && workspaceWindow.contains(panel)) panel.focus();
          return 'selected';
        }

        const tab = [...workspaceWindow.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
          (element) =>
            element.getAttribute('aria-controls') ===
            `${expectedWindowId}-panel-${expectedSurfaceId}`,
        );
        if (tab) {
          if (tab.disabled || tab.getAttribute('aria-disabled') === 'true') return 'disabled';
          tab.click();
          return 'clicked';
        }

        const measured = [
          ...workspaceWindow.querySelectorAll<HTMLElement>('[data-window-tab-measure-id]'),
        ].some((element) => element.dataset.windowTabMeasureId === expectedSurfaceId);
        return measured ? 'menu' : 'missing-surface';
      },
      { expectedSurfaceId: surfaceId, expectedWindowId: targetWindowId },
    );

    if (result === 'disabled') throw new Error(`Workspace surface is disabled: ${surfaceId}`);
    if (result === 'missing-window') throw new Error(`Missing workspace window: ${targetWindowId}`);
    if (result === 'missing-surface') throw new Error(`Missing workspace surface: ${surfaceId}`);
    if (result === 'menu') {
      await this.openWorkspaceWindowActions(targetWindowId);
      await this.#page.waitForFunction(
        ({ expectedSurfaceId, expectedWindowId }) => {
          const menu = [
            ...document.querySelectorAll<HTMLElement>('[data-workspace-window-menu]'),
          ].find((element) => element.dataset.workspaceWindowMenu === expectedWindowId);
          const item = menu
            ? [...menu.querySelectorAll<HTMLElement>('[data-workspace-hidden-tab-id]')].find(
                (element) => element.dataset.workspaceHiddenTabId === expectedSurfaceId,
              )
            : null;
          return item != null && item.getAttribute('aria-disabled') !== 'true';
        },
        { timeout: 20_000 },
        { expectedSurfaceId: surfaceId, expectedWindowId: targetWindowId },
      );
      try {
        await this.#page.evaluate(
          ({ expectedSurfaceId, expectedWindowId }) => {
            const menu = [
              ...document.querySelectorAll<HTMLElement>('[data-workspace-window-menu]'),
            ].find((element) => element.dataset.workspaceWindowMenu === expectedWindowId);
            const item = menu
              ? [...menu.querySelectorAll<HTMLElement>('[data-workspace-hidden-tab-id]')].find(
                  (element) => element.dataset.workspaceHiddenTabId === expectedSurfaceId,
                )
              : null;
            if (!item) throw new Error(`Missing workspace surface: ${expectedSurfaceId}`);
            item.click();
          },
          { expectedSurfaceId: surfaceId, expectedWindowId: targetWindowId },
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Promise was collected'))
          throw error;
      }
    }

    await this.#page.waitForFunction(
      ({ expectedSurfaceId, expectedWindowId }) =>
        [...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]')].some(
          (element) =>
            element.dataset.workspaceWindowId === expectedWindowId &&
            element.dataset.workspaceWindowActiveSurface === expectedSurfaceId &&
            element.dataset.workspaceWindowCurrent === 'true',
        ),
      { timeout: 20_000 },
      { expectedSurfaceId: surfaceId, expectedWindowId: targetWindowId },
    );
  }

  async setViewport(width: number, height: number): Promise<void> {
    const workspaceMounted =
      (await this.#page.$('[role="region"][aria-label="Workspace"]')) !== null;
    // Resizes only; changing Puppeteer device emulation can reload and erase ephemeral focus.
    await this.#page.setViewport({ width, height });
    await this.#page.waitForFunction(
      (expected) => matchMedia('(max-width: 768px)').matches === expected,
      { timeout: 20_000 },
      width <= 768,
    );
    await this.#page.evaluate(() => window.dispatchEvent(new Event('resize')));
    if (!workspaceMounted) return;
    await this.#page.waitForFunction(
      (expected) => (document.querySelector('.mobile-shell') !== null) === expected,
      { timeout: 20_000 },
      width <= 768,
    );
  }

  async openWorkspaceWindowActions(windowId?: string): Promise<void> {
    const targetWindowId = windowId ?? (await this.currentWorkspaceWindowId());
    await this.#page.evaluate((expectedWindowId) => {
      const trigger = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-workspace-window-menu-trigger]'),
      ].find((element) => element.dataset.workspaceWindowMenuTrigger === expectedWindowId);
      if (!trigger) throw new Error(`Missing workspace window menu: ${expectedWindowId}`);
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    }, targetWindowId);
  }

  async openWorkspaceWindowAddMenu(windowId?: string): Promise<void> {
    const targetWindowId = windowId ?? (await this.currentWorkspaceWindowId());
    await this.#page.evaluate((expectedWindowId) => {
      const trigger = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-workspace-window-add-trigger]'),
      ].find((element) => element.dataset.workspaceWindowAddTrigger === expectedWindowId);
      if (!trigger) throw new Error(`Missing workspace window add menu: ${expectedWindowId}`);
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    }, targetWindowId);
  }

  async clickResponsiveAction(
    name: string,
    options: ResponsiveActionClickOptions = {},
  ): Promise<void> {
    const rootSelector = options.within
      ? `${options.within} [data-responsive-surface-actions]`
      : '[data-responsive-surface-actions]';
    try {
      await this.#page.waitForFunction(
        ({ expected, selector }) =>
          [...document.querySelectorAll<HTMLElement>(selector)].some((root) => {
            const hasMeasuredAction = [
              ...root.querySelectorAll<HTMLButtonElement>('[data-surface-action-measure]'),
            ].some(
              (button) =>
                (button.getAttribute('aria-label') || button.textContent?.trim()) === expected,
            );
            if (!hasMeasuredAction) return false;

            const hasVisibleAction = [
              ...root.querySelectorAll<HTMLButtonElement>('[data-surface-action-id]'),
            ].some(
              (button) =>
                (button.getAttribute('aria-label') || button.textContent?.trim()) === expected,
            );
            return (
              hasVisibleAction ||
              root.querySelector('[data-responsive-surface-menu-trigger]') !== null
            );
          }),
        { timeout: 20_000 },
        { expected: name, selector: rootSelector },
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
      throw new Error(`Missing responsive action: ${name}`, { cause: error });
    }

    const result = await this.#page.evaluate(
      ({ expected, selector }) => {
        const roots = [...document.querySelectorAll<HTMLElement>(selector)];
        const root = roots.find((element) =>
          [...element.querySelectorAll<HTMLButtonElement>('[data-surface-action-measure]')].some(
            (button) =>
              (button.getAttribute('aria-label') || button.textContent?.trim()) === expected,
          ),
        );
        if (!root) return 'missing';

        const button = [
          ...root.querySelectorAll<HTMLButtonElement>('[data-surface-action-id]'),
        ].find(
          (element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) === expected,
        );
        if (button) {
          if (button.disabled || button.getAttribute('aria-disabled') === 'true') return 'disabled';
          button.click();
          return 'clicked';
        }

        const menuTrigger = root.querySelector<HTMLButtonElement>(
          '[data-responsive-surface-menu-trigger]',
        );
        if (!menuTrigger) return 'missing-menu';
        menuTrigger.click();
        return 'menu';
      },
      { expected: name, selector: rootSelector },
    );

    if (result === 'clicked') return;
    if (result === 'disabled') throw new Error(`Responsive action is disabled: ${name}`);
    if (result === 'missing') throw new Error(`Missing responsive action: ${name}`);
    if (result === 'missing-menu') throw new Error(`Missing responsive action menu: ${name}`);
    await this.waitForMenuItemEnabled(name);
    await this.clickMenuItem(name);
  }

  async clickMenuItem(name: string): Promise<void> {
    try {
      await this.#page.evaluate((expected) => {
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) === expected,
        );
        if (!item) throw new Error(`Missing menu item: ${expected}`);
        if (item.getAttribute('aria-disabled') === 'true') {
          throw new Error(`Menu item is disabled: ${expected}`);
        }
        item.click();
      }, name);
    } catch (error) {
      // Lightpanda can collect the CDP promise when the click unmounts the menu.
      // Each caller's next product milestone still verifies that the click took effect.
      if (!(error instanceof Error) || !error.message.includes('Promise was collected'))
        throw error;
    }
  }

  async waitForMenuItemEnabled(name: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some(
          (element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) === expected &&
            element.getAttribute('aria-disabled') !== 'true',
        ),
      { timeout: 20_000 },
      name,
    );
  }

  async clickDialogButton(name: string): Promise<void> {
    await this.#page.evaluate((expected) => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const button = dialog
        ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
            (element) =>
              (element.getAttribute('aria-label') || element.textContent?.trim()) === expected,
          )
        : null;
      if (!button) throw new Error(`Missing dialog button: ${expected}`);
      if (button.disabled) throw new Error(`Dialog button is disabled: ${expected}`);
      button.click();
    }, name);
  }

  async clickEditComparison(options: { within?: string } = {}): Promise<void> {
    await this.#page.waitForFunction(
      (rootSelector) => {
        const root = rootSelector ? document.querySelector(rootSelector) : document;
        return (
          root !== null &&
          [...root.querySelectorAll<HTMLButtonElement>('button[data-git-comparison-range]')].some(
            (element) => !element.closest('[aria-hidden="true"]'),
          )
        );
      },
      { timeout: 20_000 },
      options.within ?? null,
    );
    await this.#page.evaluate((rootSelector) => {
      const root = rootSelector ? document.querySelector(rootSelector) : document;
      const button = [
        ...(root?.querySelectorAll<HTMLButtonElement>('button[data-git-comparison-range]') ?? []),
      ].find((element) => !element.closest('[aria-hidden="true"]'));
      if (!button) throw new Error('Missing comparison range edit button.');
      button.click();
    }, options.within ?? null);
  }

  async userMessageNavigatorRows(): Promise<string[]> {
    return this.#page.$$eval('[data-user-message-navigator-row]', (rows) =>
      rows.map((row) => row.textContent?.trim() ?? ''),
    );
  }

  async clickUserMessageNavigatorRowContaining(text: string): Promise<void> {
    await this.#page.evaluate((expected) => {
      const row = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-user-message-navigator-row]'),
      ].find((element) => element.textContent?.includes(expected));
      if (!row) throw new Error(`Missing user-message navigator row containing: ${expected}`);
      row.click();
    }, text);
  }

  async userMessageNavigatorRowIdContaining(text: string): Promise<string> {
    return this.#page.evaluate((expected) => {
      const navigatorRow = [
        ...document.querySelectorAll<HTMLElement>('[data-user-message-navigator-row]'),
      ].find((element) => element.textContent?.includes(expected));
      const rowId = navigatorRow?.dataset.userMessageNavigatorRow;
      if (!rowId) throw new Error(`Missing user-message navigator row containing: ${expected}`);
      return rowId;
    }, text);
  }

  async trackChatScrollRequests(): Promise<void> {
    await this.#page.$eval('[data-chat-scroll-viewport]', (element) => {
      const feed = element as HTMLElement;
      let prototype: object | null = feed;
      let descriptor: PropertyDescriptor | undefined;
      while (prototype && !descriptor) {
        prototype = Object.getPrototypeOf(prototype);
        descriptor = prototype
          ? Object.getOwnPropertyDescriptor(prototype, 'scrollTop')
          : undefined;
      }
      if (!descriptor?.get || !descriptor.set) {
        throw new Error('Missing native scrollTop descriptor.');
      }
      feed.dataset.testScrollRequests = '[]';
      Object.defineProperty(feed, 'scrollTop', {
        configurable: true,
        get: () => descriptor.get?.call(feed),
        set: (value: number) => {
          const requests = JSON.parse(feed.dataset.testScrollRequests ?? '[]') as number[];
          requests.push(value);
          feed.dataset.testScrollRequests = JSON.stringify(requests);
          descriptor.set?.call(feed, value);
        },
      });
    });
  }

  async waitForChatScrollRequest(timeout = 20_000): Promise<void> {
    // Lightpanda proves that navigation reaches the viewport; Chromium owns landing geometry.
    await this.#page.waitForFunction(
      () => {
        const feed = document.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
        const requests = JSON.parse(feed?.dataset.testScrollRequests ?? '[]') as number[];
        return requests.length > 0;
      },
      { timeout },
    );
  }

  async clickSidebarChatContaining(text: string): Promise<void> {
    await this.#page.evaluate((expected) => {
      const summary = [
        ...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-chat-summary"]'),
      ].find((element) => element.innerText.includes(expected));
      const button = summary?.closest('button') as HTMLButtonElement | null;
      if (!button) throw new Error(`Missing sidebar chat containing: ${expected}`);
      button.click();
    }, text);
  }

  async openSidebarChatInNewWindow(text: string): Promise<void> {
    await this.#page.evaluate((expected) => {
      const summary = [
        ...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-chat-summary"]'),
      ].find((element) => element.innerText.includes(expected));
      const row = summary?.closest<HTMLElement>('[data-sidebar-virtual-row]');
      const trigger = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.getAttribute('aria-label') === 'Chat actions',
      );
      if (!trigger) throw new Error(`Missing sidebar Chat actions for: ${expected}`);
      trigger.click();
    }, text);
    await this.waitForMenuItemEnabled('Open in new window');
    await this.clickMenuItem('Open in new window');
  }

  async waitForSidebarPreview(chatText: string, previewText: string): Promise<void> {
    await this.#page.waitForFunction(
      (chatMarker, preview) => {
        const summary = [
          ...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-chat-summary"]'),
        ].find((element) => element.innerText.includes(chatMarker));
        return summary?.innerText.includes(preview) === true;
      },
      { timeout: 20_000 },
      chatText,
      previewText,
    );
  }

  async waitForSidebarUnread(chatText: string, expected: boolean): Promise<void> {
    await this.#page.waitForFunction(
      (chatMarker, shouldBeUnread) => {
        const summary = [
          ...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-chat-summary"]'),
        ].find((element) => element.innerText.includes(chatMarker));
        if (!summary) return false;
        return (
          Boolean(summary.querySelector('[data-slot="sidebar-chat-unread-status"]')) ===
          shouldBeUnread
        );
      },
      { timeout: 20_000 },
      chatText,
      expected,
    );
  }

  async clickQueuedRowAction(content: string, action: QueueRowAction): Promise<void> {
    await this.#page.evaluate(
      ({ content, action }) => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        if (!dialog) throw new Error('Queued messages dialog is not open.');
        const message = [...dialog.querySelectorAll<HTMLElement>('p')].find(
          (element) => element.textContent?.trim() === content,
        );
        const row = message?.parentElement?.parentElement;
        const button = row
          ? [...row.querySelectorAll<HTMLButtonElement>('button')].find(
              (element) =>
                (element.getAttribute('aria-label') || element.textContent?.trim()) === action,
            )
          : null;
        if (!button) throw new Error(`Missing ${action} action for queued message: ${content}`);
        if (button.disabled)
          throw new Error(`${action} is disabled for queued message: ${content}`);
        button.click();
      },
      { content, action },
    );
  }

  async clickQueuedMove(content: string, direction: QueueMoveDirection): Promise<void> {
    await this.#page.evaluate(
      ({ content, direction }) => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        if (!dialog) throw new Error('Queued messages dialog is not open.');
        const row = [...dialog.querySelectorAll<HTMLLIElement>('ol > li')].find((element) =>
          [...element.querySelectorAll('p')].some(
            (message) => message.textContent?.trim() === content,
          ),
        );
        const button = row?.querySelector<HTMLButtonElement>(
          `[data-queue-move-direction="${direction}"]`,
        );
        if (!button)
          throw new Error(`Missing move ${direction} action for queued message: ${content}`);
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
          throw new Error(`Move ${direction} is disabled for queued message: ${content}`);
        }
        button.focus();
        button.click();
      },
      { content, direction },
    );
  }

  async waitForQueuedDialogOrder(contents: string[]): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => {
        const rows = [...document.querySelectorAll<HTMLLIElement>('[role="dialog"] ol > li')];
        const actual = rows.map((row) =>
          [...row.querySelectorAll('p')]
            .find((message) => expected.includes(message.textContent?.trim() ?? ''))
            ?.textContent?.trim(),
        );
        return (
          actual.length === expected.length &&
          actual.every((content, index) => content === expected[index])
        );
      },
      { timeout: 20_000 },
      contents,
    );
  }

  async waitForFocusedQueuedMove(content: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => {
        const active = document.activeElement as HTMLButtonElement | null;
        if (!active?.matches('[data-queue-move-id]')) return false;
        const row = active.closest('li');
        return [...(row?.querySelectorAll('p') ?? [])].some(
          (message) => message.textContent?.trim() === expected,
        );
      },
      { timeout: 20_000 },
      content,
    );
  }

  async fillQueuedEditor(value: string): Promise<void> {
    await this.fill('[role="dialog"] textarea', value);
  }

  async waitForButton(name: string, options: { timeout?: number } = {}): Promise<void> {
    await this.#page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('button')].some(
          (element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) === expected,
        ),
      { timeout: options.timeout ?? 20_000 },
      name,
    );
  }

  async waitForButtonEnabled(name: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('button')].some((element) => {
          const button = element as HTMLButtonElement;
          return (
            (button.getAttribute('aria-label') || button.textContent?.trim()) === expected &&
            !button.disabled
          );
        }),
      { timeout: 20_000 },
      name,
    );
  }

  async waitForDialogButtonEnabled(name: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('[role="dialog"] button')].some((element) => {
          const button = element as HTMLButtonElement;
          return (
            (button.getAttribute('aria-label') || button.textContent?.trim()) === expected &&
            !button.disabled
          );
        }),
      { timeout: 20_000 },
      name,
    );
  }

  async waitForText(text: string, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => document.body.innerText.includes(expected),
      { timeout },
      text,
    );
  }

  async waitForAssistantMessageContaining(text: string, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('[data-chat-message-type="assistant-message"]')].some((row) =>
          row.textContent?.includes(expected),
        ),
      { timeout },
      text,
    );
  }

  async waitForAriaLabel(label: string, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('[aria-label]')].some(
          (element) => element.getAttribute('aria-label') === expected,
        ),
      { timeout },
      label,
    );
  }

  async waitForChatProcessing(expected: boolean, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (shouldBeProcessing) =>
        (document.querySelector('[data-slot="chat-processing-status"]') !== null) ===
        shouldBeProcessing,
      { timeout },
      expected,
    );
  }

  async waitForTextAbsent(text: string, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => !document.body.innerText.includes(expected),
      { timeout },
      text,
    );
  }

  // Counts user rows rather than any leaf, so a reply quoting the prompt back cannot be
  // mistaken for a second delivery.
  async waitForExactUserMessageCount(text: string, count: number, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected, expectedCount) => {
        const log = document.querySelector('[data-chat-scroll-viewport]');
        if (!log) return expectedCount === 0;
        const actual = [...log.querySelectorAll('[data-chat-message-type="user-message"]')].filter(
          (row) => row.textContent?.trim() === expected,
        ).length;
        return actual === expectedCount;
      },
      { timeout },
      text,
      count,
    );
  }

  async waitForExactTextCount(text: string, count: number, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected, expectedCount) => {
        const log = document.querySelector('[data-chat-scroll-viewport]');
        if (!log) return expectedCount === 0;
        const actual = [...log.querySelectorAll('*')].filter(
          (element) => element.children.length === 0 && element.textContent?.trim() === expected,
        ).length;
        return actual === expectedCount;
      },
      { timeout },
      text,
      count,
    );
  }

  async waitForSelectedChat(chatId: string, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expectedPath) => window.location.pathname === expectedPath,
      { timeout },
      `/chat/${encodeURIComponent(chatId)}`,
    );
  }

  async waitForSelectedChatChange(chatId: string, timeout = 20_000): Promise<string> {
    const sourcePath = `/chat/${encodeURIComponent(chatId)}`;
    await this.#page.waitForFunction(
      (previousPath) =>
        window.location.pathname.startsWith('/chat/') && window.location.pathname !== previousPath,
      { timeout },
      sourcePath,
    );
    return await this.#page.evaluate(() =>
      decodeURIComponent(window.location.pathname.slice('/chat/'.length)),
    );
  }

  async waitForQueuedPreview(content: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) =>
        document.querySelector('[data-queue-preview]')?.textContent?.trim() === expected,
      { timeout: 20_000 },
      content,
    );
  }

  async queuedPreviewText(): Promise<string | null> {
    return this.#page
      .$eval('[data-queue-preview]', (element) => element.textContent?.trim() ?? null)
      .catch(() => null);
  }

  async hasButton(name: string): Promise<boolean> {
    return this.#page.evaluate(
      (expected) =>
        [...document.querySelectorAll('button')].some(
          (element) =>
            !element.closest('[aria-hidden="true"]') &&
            (element.getAttribute('aria-label') || element.textContent?.trim()) === expected,
        ),
      name,
    );
  }

  async hasResponsiveAction(name: string): Promise<boolean> {
    return this.#page.evaluate(
      (expected) =>
        [...document.querySelectorAll<HTMLButtonElement>('[data-surface-action-measure]')].some(
          (element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) === expected,
        ),
      name,
    );
  }

  async exactTextCount(text: string): Promise<number> {
    return this.#page.evaluate((expected) => {
      const log = document.querySelector('[data-chat-scroll-viewport]');
      if (!log) return 0;
      return [...log.querySelectorAll('*')].filter(
        (element) => element.children.length === 0 && element.textContent?.trim() === expected,
      ).length;
    }, text);
  }

  async bodyText(): Promise<string> {
    return this.#page.evaluate(() => document.body.innerText);
  }
}
