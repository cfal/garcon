import type { Page } from 'puppeteer-core';
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
    const response = await this.#page.goto(this.#integration.garcon.baseUrl, {
      // Lightpanda 0.3.5 executes the document but does not consistently report
      // DOMContentLoaded over CDP. The rendered control is the readiness boundary.
      waitUntil: [],
    });
    if (!response?.ok()) throw new Error(`SPA navigation failed with status ${response?.status()}`);
    await this.#page.waitForFunction(() => document.querySelector('button') !== null);
  }

  async startDirectChat(content: string): Promise<RecordedCompletionRequest> {
    await this.clickButton('New Chat');
    await this.#page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog !== null
          && dialog.querySelector('[role="status"][aria-label="Loading chat defaults..."]') === null;
      },
      { timeout: 20_000 },
    );
    await this.#page.waitForFunction(
      () => document.activeElement?.matches(
        '[role="dialog"] textarea[placeholder="How can I help you today?"]',
      ) === true,
      { timeout: 20_000 },
    );
    const directProviderSelected = await this.#page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return [...(dialog?.querySelectorAll('button') ?? [])].some((element) => {
        const name = element.getAttribute('aria-label') || element.textContent?.trim() || '';
        return name.includes('Direct (Chat Completions)') && name.includes('Integration Echo');
      });
    });
    if (!directProviderSelected) {
      await this.clickNewChatDialogButtonContaining('Claude /');
      await this.#page.waitForFunction(
        () => document.body.innerText.includes('Direct (Chat Completions)'),
        { timeout: 30_000 },
      );
      await this.clickButton('Direct (Chat Completions)');
      await this.clickButton('Integration Echo');
    }

    const projectPath = await this.#page.$eval(
      '[role="dialog"] input[aria-label="Project Path"]',
      (element) => (element as HTMLInputElement).value,
    );
    if (projectPath !== this.#integration.dirs.project) {
      await this.fill(
        '[role="dialog"] input[aria-label="Project Path"]',
        this.#integration.dirs.project,
      );
    }
    await this.fill('[role="dialog"] textarea[placeholder="How can I help you today?"]', content);
    await this.waitForDialogButtonEnabled('Start session');
    await this.clickButton('Start session');
    const request = await this.#integration.fakeOpenAi.waitForRequest(
      { lastUserText: content },
      { timeoutMs: 20_000 },
    );
    await this.#page.waitForFunction(
      () => document.querySelector('[role="dialog"]') === null,
      { timeout: 20_000 },
    );
    return request;
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
    try {
      await this.#page.evaluate(({ name, contains, last }) => {
        const buttons = [...document.querySelectorAll('button')].filter((element) => {
          const accessibleName = element.getAttribute('aria-label') || element.textContent?.trim() || '';
          return contains ? accessibleName.includes(name) : accessibleName === name;
        });
        const button = (last ? buttons.at(-1) : buttons[0]) as HTMLButtonElement | undefined;
        if (!button) throw new Error(`Missing button: ${name}`);
        if (button.disabled) throw new Error(`Button is disabled: ${name}`);
        button.click();
      }, { name, contains: options.contains === true, last: options.last === true });
    } catch (error) {
      // Lightpanda may collect the CDP evaluation promise when a click replaces
      // the document. The next positive product milestone still verifies it.
      if (!(error instanceof Error) || !error.message.includes('Promise was collected')) throw error;
    }
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
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const button = dialog
        ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim()) === expected)
        : null;
      if (!button) throw new Error(`Missing dialog button: ${expected}`);
      if (button.disabled) throw new Error(`Dialog button is disabled: ${expected}`);
      button.click();
    }, name);
  }

  async clickNewChatDialogButtonContaining(name: string): Promise<void> {
    await this.#page.evaluate((expected) => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const button = dialog
        ? [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
            (element.getAttribute('aria-label') || element.textContent?.trim() || '')
              .includes(expected))
        : null;
      if (!button) throw new Error(`Missing new chat dialog button containing: ${expected}`);
      if (button.disabled) throw new Error(`New chat dialog button is disabled: ${expected}`);
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
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
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
    await this.fill('[role="dialog"] textarea', value);
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
      (expected) => [...document.querySelectorAll('[role="dialog"] button')].some((element) => {
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
        (element.getAttribute('aria-label') || element.textContent?.trim()) === expected), name);
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
