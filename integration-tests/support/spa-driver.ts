import type { Page } from 'puppeteer-core';
import type { RecordedAnthropicRequest } from './fake-anthropic-server.js';
import type { RecordedCompletionRequest } from './fake-openai-server.js';
import type { IntegrationFixture } from './integration-fixture.js';

interface ClickOptions {
  contains?: boolean;
  last?: boolean;
}

type QueueRowAction = 'Edit queued message' | 'Remove from queue';

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
    await this.#openUrl(
      `${this.#integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    );
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

  async startOpenAiDirectChat(content: string): Promise<RecordedCompletionRequest> {
    return this.#startDirectChat({
      content,
      agentLabel: 'Direct (Chat Completions)',
      modelLabel: 'Integration Echo',
      waitForRequest: () => this.#integration.fakeProviders.openAi.waitForRequest(
        { lastUserText: content },
        { timeoutMs: 20_000 },
      ),
    });
  }

  async startAnthropicDirectChat(content: string): Promise<RecordedAnthropicRequest> {
    return this.#startDirectChat({
      content,
      agentLabel: 'Direct (Anthropic)',
      modelLabel: 'Integration Anthropic Echo',
      waitForRequest: () => this.#integration.fakeProviders.anthropic.waitForRequest(
        { lastUserText: content },
        { timeoutMs: 20_000 },
      ),
    });
  }

  async #startDirectChat<TRequest>(input: {
    content: string;
    agentLabel: string;
    modelLabel: string;
    waitForRequest: () => Promise<TRequest>;
  }): Promise<TRequest> {
    await this.clickButton('New Chat');
    // Modal dialogs are matched by the shared Dialog component's data-slot rather
    // than role="dialog": the workspace sidebar overlay is also a role="dialog"
    // and, now open by default, would otherwise be selected instead of the modal.
    await this.#page.waitForFunction(
      () => {
        const dialog = document.querySelector('[data-slot="dialog-content"]');
        return dialog !== null
          && dialog.querySelector('[role="status"][aria-label="Loading chat defaults..."]') === null;
      },
      { timeout: 20_000 },
    );
    await this.#page.waitForFunction(
      () => document.activeElement?.matches(
        '[data-slot="dialog-content"] textarea[placeholder="How can I help you today?"]',
      ) === true,
      { timeout: 20_000 },
    );
    const directProviderSelected = await this.#page.evaluate(({ agentLabel, modelLabel }) => {
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      return [...(dialog?.querySelectorAll('button') ?? [])].some((element) => {
        const name = element.getAttribute('aria-label') || element.textContent?.trim() || '';
        return name.includes(agentLabel) && name.includes(modelLabel);
      });
    }, { agentLabel: input.agentLabel, modelLabel: input.modelLabel });
    if (!directProviderSelected) {
      await this.#clickNewChatModelSelector();
      await this.#page.waitForFunction(
        (agentLabel) => document.body.innerText.includes(agentLabel),
        { timeout: 30_000 },
        input.agentLabel,
      );
      await this.clickButton(input.agentLabel);
      await this.clickButton(input.modelLabel);
    }

    const projectPath = await this.#page.$eval(
      '[data-slot="dialog-content"] input[aria-label="Project Path"]',
      (element) => (element as HTMLInputElement).value,
    );
    if (projectPath !== this.#integration.dirs.project) {
      await this.fill(
        '[data-slot="dialog-content"] input[aria-label="Project Path"]',
        this.#integration.dirs.project,
      );
    }
    await this.fill('[data-slot="dialog-content"] textarea[placeholder="How can I help you today?"]', input.content);
    await this.waitForDialogButtonEnabled('Start session');
    await this.clickButton('Start session');
    const request = await input.waitForRequest();
    await this.#page.waitForFunction(
      () => document.querySelector('[data-slot="dialog-content"]') === null,
      { timeout: 20_000 },
    );
    return request;
  }

  async #clickNewChatModelSelector(): Promise<void> {
    await this.#page.waitForFunction(
      () => {
        const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
        const button = dialog
          ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
              (element.getAttribute('aria-label') ?? '').includes(' / '))
          : null;
        return button !== null && button !== undefined && !button.disabled;
      },
      { timeout: 20_000 },
    );
    await this.#page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
      const button = dialog
        ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
            (element.getAttribute('aria-label') ?? '').includes(' / '))
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

  async waitForTranscriptSearchResult(input: {
    count: number;
    snippet: string;
  }): Promise<void> {
    await this.#page.waitForFunction(
      ({ count, snippet }) => {
        const rows = [...document.querySelectorAll(
          '[data-slot="search-dialog-results"] [role="option"]',
        )];
        return rows.length === count
          && rows.some((row) => row.textContent?.includes(snippet));
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
    const title = await this.#page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((element) => {
        const name = element.getAttribute('aria-label') || element.textContent?.trim();
        return (name === 'Send message' || name === 'Queue message')
          && !(element as HTMLButtonElement).disabled;
      });
      return button?.getAttribute('aria-label') || button?.textContent?.trim() || null;
    }, { timeout: 20_000 }).then((handle) => handle.jsonValue());
    if (typeof title !== 'string') throw new Error('Composer send action did not become available.');
    await this.clickButton(title);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.#page.$eval(selector, (element, nextValue) => {
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      const prototype = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }

  async clickButton(name: string, options: ClickOptions = {}): Promise<void> {
    const params = { name, contains: options.contains === true, last: options.last === true };
    // A button can render a beat after navigation or a WebSocket-driven update
    // (the open sidebar adds initial render work), so wait for it before clicking
    // rather than failing on the first probe.
    await this.#page.waitForFunction(
      ({ name, contains }) =>
        [...document.querySelectorAll('button')].some((element) => {
          if (element.closest('[aria-hidden="true"]')) return false;
          const accessibleName = element.getAttribute('aria-label') || element.textContent?.trim() || '';
          return contains ? accessibleName.includes(name) : accessibleName === name;
        }),
      { timeout: 20_000 },
      params,
    );
    try {
      await this.#page.evaluate(({ name, contains, last }) => {
        const buttons = [...document.querySelectorAll('button')].filter((element) => {
          if (element.closest('[aria-hidden="true"]')) return false;
          const accessibleName = element.getAttribute('aria-label') || element.textContent?.trim() || '';
          return contains ? accessibleName.includes(name) : accessibleName === name;
        });
        const button = (last ? buttons.at(-1) : buttons[0]) as HTMLButtonElement | undefined;
        if (!button) throw new Error(`Missing button: ${name}`);
        if (button.disabled) throw new Error(`Button is disabled: ${name}`);
        button.click();
      }, params);
    } catch (error) {
      // Lightpanda may collect the CDP evaluation promise when a click replaces
      // the document. The next positive product milestone still verifies it.
      if (!(error instanceof Error) || !error.message.includes('Promise was collected')) throw error;
    }
  }

  async clickResponsiveAction(name: string): Promise<void> {
    const result = await this.#page.evaluate((expected) => {
      const roots = [...document.querySelectorAll<HTMLElement>('[data-responsive-surface-actions]')];
      const root = roots.find((element) =>
        [...element.querySelectorAll<HTMLButtonElement>('[data-surface-action-measure]')].some(
          (button) =>
            (button.getAttribute('aria-label') || button.textContent?.trim()) === expected,
        ));
      if (!root) return 'missing';

      const button = [...root.querySelectorAll<HTMLButtonElement>('[data-surface-action-id]')].find(
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
    }, name);

    if (result === 'clicked') return;
    if (result === 'disabled') throw new Error(`Responsive action is disabled: ${name}`);
    if (result === 'missing') throw new Error(`Missing responsive action: ${name}`);
    if (result === 'missing-menu') throw new Error(`Missing responsive action menu: ${name}`);
    await this.waitForMenuItemEnabled(name);
    await this.clickMenuItem(name);
  }

  async clickMenuItem(name: string): Promise<void> {
    await this.#page.evaluate((expected) => {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
        (element.getAttribute('aria-label') || element.textContent?.trim()) === expected);
      if (!item) throw new Error(`Missing menu item: ${expected}`);
      if (item.getAttribute('aria-disabled') === 'true') {
        throw new Error(`Menu item is disabled: ${expected}`);
      }
      item.click();
    }, name);
  }

  async waitForMenuItemEnabled(name: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some((element) =>
        (element.getAttribute('aria-label') || element.textContent?.trim()) === expected
        && element.getAttribute('aria-disabled') !== 'true'),
      { timeout: 20_000 },
      name,
    );
  }

  async clickDialogButton(name: string): Promise<void> {
    await this.#page.evaluate((expected) => {
      const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
      const button = dialog
        ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) === expected)
        : null;
      if (!button) throw new Error(`Missing dialog button: ${expected}`);
      if (button.disabled) throw new Error(`Dialog button is disabled: ${expected}`);
      button.click();
    }, name);
  }

  async clickSidebarChatContaining(text: string): Promise<void> {
    await this.#page.evaluate((expected) => {
      const summary = [...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-chat-summary"]')]
        .find((element) => element.innerText.includes(expected));
      const button = summary?.closest('button') as HTMLButtonElement | null;
      if (!button) throw new Error(`Missing sidebar chat containing: ${expected}`);
      button.click();
    }, text);
  }

  async waitForSidebarPreview(chatText: string, previewText: string): Promise<void> {
    await this.#page.waitForFunction(
      (chatMarker, preview) => {
        const summary = [...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-chat-summary"]')]
          .find((element) => element.innerText.includes(chatMarker));
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
        const summary = [...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-chat-summary"]')]
          .find((element) => element.innerText.includes(chatMarker));
        if (!summary) return false;
        return Boolean(summary.querySelector('[aria-label="Unread"]')) === shouldBeUnread;
      },
      { timeout: 20_000 },
      chatText,
      expected,
    );
  }

  async clickQueuedRowAction(content: string, action: QueueRowAction): Promise<void> {
    await this.#page.evaluate(({ content, action }) => {
      const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
      if (!dialog) throw new Error('Queued messages dialog is not open.');
      const message = [...dialog.querySelectorAll<HTMLElement>('p')].find((element) =>
        element.textContent?.trim() === content);
      const row = message?.parentElement?.parentElement;
      const button = row
        ? [...row.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) === action)
        : null;
      if (!button) throw new Error(`Missing ${action} action for queued message: ${content}`);
      if (button.disabled) throw new Error(`${action} is disabled for queued message: ${content}`);
      button.click();
    }, { content, action });
  }

  async fillQueuedEditor(value: string): Promise<void> {
    await this.fill('[data-slot="dialog-content"] textarea', value);
  }

  async waitForButton(name: string, options: { timeout?: number } = {}): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => [...document.querySelectorAll('button')].some((element) =>
        (element.getAttribute('aria-label') || element.textContent?.trim()) === expected),
      { timeout: options.timeout ?? 20_000 },
      name,
    );
  }

  async waitForButtonEnabled(name: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => [...document.querySelectorAll('button')].some((element) => {
        const button = element as HTMLButtonElement;
        return (button.getAttribute('aria-label') || button.textContent?.trim()) === expected
          && !button.disabled;
      }),
      { timeout: 20_000 },
      name,
    );
  }

  async waitForDialogButtonEnabled(name: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => [...document.querySelectorAll('[data-slot="dialog-content"] button')].some((element) => {
        const button = element as HTMLButtonElement;
        return (button.getAttribute('aria-label') || button.textContent?.trim()) === expected
          && !button.disabled;
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

  async waitForAriaLabel(label: string, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => [...document.querySelectorAll('[aria-label]')].some((element) =>
        element.getAttribute('aria-label') === expected),
      { timeout },
      label,
    );
  }

  async waitForTextAbsent(text: string, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => !document.body.innerText.includes(expected),
      { timeout },
      text,
    );
  }

  async waitForExactTextCount(text: string, count: number, timeout = 20_000): Promise<void> {
    await this.#page.waitForFunction(
      (expected, expectedCount) => {
        const log = document.querySelector('[role="log"][aria-label="Chat messages"]');
        if (!log) return expectedCount === 0;
        const actual = [...log.querySelectorAll('*')].filter((element) =>
          element.children.length === 0 && element.textContent?.trim() === expected).length;
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
      (previousPath) => window.location.pathname.startsWith('/chat/')
        && window.location.pathname !== previousPath,
      { timeout },
      sourcePath,
    );
    return await this.#page.evaluate(() =>
      decodeURIComponent(window.location.pathname.slice('/chat/'.length)));
  }

  async waitForQueuedPreview(content: string): Promise<void> {
    await this.#page.waitForFunction(
      (expected) => document.querySelector('[data-queue-preview]')?.textContent?.trim() === expected,
      { timeout: 20_000 },
      content,
    );
  }

  async queuedPreviewText(): Promise<string | null> {
    return this.#page.$eval(
      '[data-queue-preview]',
      (element) => element.textContent?.trim() ?? null,
    ).catch(() => null);
  }

  async hasButton(name: string): Promise<boolean> {
    return this.#page.evaluate((expected) =>
      [...document.querySelectorAll('button')].some((element) =>
        !element.closest('[aria-hidden="true"]')
        && (element.getAttribute('aria-label') || element.textContent?.trim()) === expected), name);
  }

  async hasResponsiveAction(name: string): Promise<boolean> {
    return this.#page.evaluate((expected) =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-surface-action-measure]')].some(
        (element) =>
          (element.getAttribute('aria-label') || element.textContent?.trim()) === expected,
      ), name);
  }

  async exactTextCount(text: string): Promise<number> {
    return this.#page.evaluate((expected) => {
      const log = document.querySelector('[role="log"][aria-label="Chat messages"]');
      if (!log) return 0;
      return [...log.querySelectorAll('*')].filter((element) =>
        element.children.length === 0 && element.textContent?.trim() === expected).length;
    }, text);
  }

  async bodyText(): Promise<string> {
    return this.#page.evaluate(() => document.body.innerText);
  }
}
