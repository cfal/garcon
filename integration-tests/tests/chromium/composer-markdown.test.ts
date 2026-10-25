import { expect, test } from "bun:test";
import { expect as browserExpect, type Page } from "playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import type { SnippetsSnapshot } from "../../../common/snippets.js";

const table =
  "| Check | Example |\n| --- | --- |\n| **Startup ready** | Resolve earlier work before submitting. |\n| **Current data** | Use the latest observation.<br>Keep context current. |\n| **Code** | `a  b` |";

async function selectMessageFormat(page: Page, mode: 'source' | 'formatted') {
  await browserExpect(page.locator('[data-composer]')).toBeVisible();
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('tab', { name: 'Interface', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Message format', exact: true }).selectOption(mode);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

test('message format defaults to Formatted and is controlled only by persisted Interface settings', async () => {
  await withChromiumFixture('composer-format-setting', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId, content: 'Synthetic format preference', projectPath: integration.dirs.project,
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const composer = page.locator('[data-composer]');
    const editor = page.getByRole('textbox', { name: 'Formatted message' });
    const textarea = composer.locator('textarea');
    await browserExpect(editor).toBeVisible();
    await browserExpect(composer.getByRole('group', { name: 'Message format' })).toHaveCount(0);
    await browserExpect(composer.getByRole('button', { name: /^(Source|Formatted)$/ })).toHaveCount(0);

    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      // No selector or spacer sits above the original input surface.
      const geometry = await composer.evaluate(element => {
        const input = element.querySelector('[data-composer-markdown-editor]')!;
        return { frameTop: element.getBoundingClientRect().top, inputTop: input.getBoundingClientRect().top };
      });
      expect(geometry.inputTop - geometry.frameTop).toBe(1);
      await browserExpect(editor.locator('p.is-editor-empty')).toHaveAttribute('data-placeholder', 'Reply...');
      expect(await editor.locator('p').evaluate(element => getComputedStyle(element, '::before').content)).toBe('"Reply..."');
      const formattedBounds = await composer.boundingBox();
      const formattedInputBounds = await composer.locator('[data-composer-markdown-editor]').boundingBox();
      await page.screenshot({ path: join(artifacts, `composer-settings-only-${width}.png`) });
      await page.keyboard.press('Control+,');
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await dialog.getByRole('tab', { name: 'Interface', exact: true }).click();
      const format = dialog.getByRole('combobox', { name: 'Message format', exact: true });
      await browserExpect(format).toHaveValue('formatted');
      await format.scrollIntoViewIfNeeded();
      await format.focus();
      await format.selectOption('source');
      await browserExpect(editor).toHaveCount(0);
      await browserExpect.poll(() => composer.boundingBox()).toEqual(formattedBounds);
      await browserExpect.poll(() => textarea.boundingBox()).toEqual(formattedInputBounds);
      await browserExpect(format).toBeFocused();
      await format.selectOption('formatted');
      await browserExpect(editor).toBeAttached();
      await browserExpect(format).toBeFocused();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: join(artifacts, `composer-interface-setting-${width}.png`) });
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const clipboard = 'def f(*args):\n    return args[0] * 2';
    await page.evaluate(text => navigator.clipboard.writeText(text), clipboard);
    await editor.focus();
    await page.keyboard.press('Control+V');
    await browserExpect(textarea).toHaveValue(clipboard);
    await browserExpect(editor).toBeFocused();
    await composer.getByRole('button', { name: 'Send message', exact: true }).click();
    await browserExpect.poll(async () =>
      (await integration.client.getMessages(chatId)).messages.flatMap(row =>
        row.message.type === 'user-message' ? [row.message.content] : []),
    ).toContain(clipboard);
    await browserExpect(editor.locator('p.is-editor-empty')).toHaveAttribute('data-placeholder', 'Reply...');
    await integration.client.waitForProcessing(chatId, false);
    await selectMessageFormat(page, 'source');
    await textarea.fill('**Source stays literal**');
    await page.reload();
    await browserExpect(textarea).toBeVisible();
    await browserExpect(textarea).toHaveValue('**Source stays literal**');
    await browserExpect(editor).toHaveCount(0);
    await selectMessageFormat(page, 'formatted');
    await browserExpect(editor.locator('strong')).toHaveText('Source stays literal');
    await page.reload();
    await browserExpect(editor.locator('strong')).toHaveText('Source stays literal');
    assertNoBrowserErrors();
  }, undefined, { composerInputMode: null });
}, 90_000);

test('deleting the last formatted text resets typing and paste marks', async () => {
  type RichEditorElement = HTMLElement & {
    editor: { state: { doc: { textContent: string }; selection: { from: number } } };
  };
  await withChromiumFixture('composer-cleared-marks', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId, content: 'Synthetic cleared formatting', projectPath: integration.dirs.project,
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const editor = page.getByRole('textbox', { name: 'Formatted message' });
    const textarea = page.locator('[data-composer] textarea');
    await browserExpect(editor).toBeVisible();
    await editor.focus();
    const original = await editor.elementHandle();

    async function deleteCharacters(key: 'Backspace' | 'Delete', length: number) {
      // Native deletion must settle before the next key reaches ProseMirror.
      for (let remaining = length; remaining > 0; remaining--) {
        await editor.press(key);
        await browserExpect.poll(() => editor.textContent()).toHaveLength(remaining - 1);
      }
    }

    for (const [source, tag] of [
      ['`hello` ', 'code'], ['**hello** ', 'strong'],
      ['_hello_ ', 'em'], ['~~hello~~ ', 's'],
    ]) {
      for (const deletion of ['Backspace', 'Delete', 'select-all', 'cut']) {
        await editor.press('Control+A');
        await editor.press('Backspace');
        const typed = deletion === 'Delete' ? source.trimEnd() : source;
        const text = deletion === 'Delete' ? 'hello' : 'hello ';
        await page.keyboard.type(typed);
        await browserExpect(editor.locator(tag)).toHaveText('hello');
        await browserExpect.poll(() => editor.evaluate(element => {
          const rich = (element as RichEditorElement).editor;
          return { text: rich.state.doc.textContent, caret: rich.state.selection.from };
        })).toEqual({ text, caret: text.length + 1 });
        // Separates the typing and deletion history groups for real keyboard Undo/Redo.
        if (tag === 'code' && deletion === 'Backspace') await page.waitForTimeout(550);
        if (deletion === 'Backspace' || deletion === 'Delete') {
          if (deletion === 'Delete') {
            await editor.press('Home');
            await browserExpect.poll(() => editor.evaluate(element =>
              (element as RichEditorElement).editor.state.selection.from,
            )).toBe(1);
          }
          await deleteCharacters(deletion, text.length);
        } else {
          await editor.press('Control+A');
          await editor.press(deletion === 'cut' ? 'Control+X' : 'Backspace');
        }
        await browserExpect(editor.locator('p.is-editor-empty')).toBeVisible();
        await browserExpect(textarea).toHaveValue('');
        await browserExpect(editor).toBeFocused();
        expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
        if (tag === 'code' && deletion === 'Backspace') {
          await editor.press('Control+z');
          await browserExpect(textarea).toHaveValue(source);
          await editor.press('Control+Shift+z');
          await browserExpect(textarea).toHaveValue('');
        }
        await page.keyboard.type('new');
        await browserExpect(textarea).toHaveValue('new');
        await browserExpect(editor.locator('code, strong, em, s')).toHaveCount(0);
      }
    }

    await editor.press('Control+A');
    await editor.press('Backspace');
    await page.keyboard.type('`hello` ');
    await browserExpect.poll(() => editor.textContent()).toBe('hello ');
    await deleteCharacters('Backspace', 6);
    await browserExpect(editor.locator('p.is-editor-empty')).toBeVisible();
    await browserExpect(textarea).toHaveValue('');
    await page.evaluate(() => navigator.clipboard.writeText('**pasted**'));
    await editor.press('Control+V');
    await browserExpect(editor.locator('strong')).toHaveText('pasted');
    await browserExpect(textarea).toHaveValue('**pasted**');
    assertNoBrowserErrors();
  }, undefined, { composerInputMode: 'formatted' });
}, 120_000);

test('raw Markdown paste retains rich history, layout, and caret visibility', async () => {
  await withChromiumFixture('composer-paste-history', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId, content: 'Synthetic paste history', projectPath: integration.dirs.project,
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const composer = page.locator('[data-composer]');
    const textarea = composer.locator('textarea');
    const editor = page.getByRole('textbox', { name: 'Formatted message' });
    const source = Array.from({ length: 24 }, (_, index) => `Paragraph ${index} with **context**`).join('\n\n');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await selectMessageFormat(page, 'source');
      await textarea.fill(source);
      await selectMessageFormat(page, 'formatted');
      await editor.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' typed');
      const original = await editor.elementHandle();
      const box = await composer.boundingBox();
      await page.evaluate(text => navigator.clipboard.writeText(text), ' **pasted**');
      await page.keyboard.press('Control+V');
      await browserExpect(textarea).toHaveValue(source + ' typed **pasted**');
      await browserExpect(editor.locator('strong').last()).toHaveText('pasted');
      expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
      expect(await composer.boundingBox()).toEqual(box);
      await browserExpect.poll(() => editor.evaluate(element => {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return false;
        const caret = selection.getRangeAt(0).getBoundingClientRect();
        const surface = element.closest('[data-composer-markdown-editor]')!;
        const bounds = surface.getBoundingClientRect();
        return surface.scrollTop > 0 && caret.top >= bounds.top && caret.bottom <= bounds.bottom;
      })).toBe(true);
      await page.keyboard.press('Control+Z');
      await browserExpect(textarea).toHaveValue(source + ' typed');
      await page.keyboard.press('Control+Z');
      await browserExpect(textarea).toHaveValue(source);
      await page.keyboard.press('Control+y');
      await page.keyboard.press('Control+y');
      await browserExpect(textarea).toHaveValue(source + ' typed **pasted**');
      await original?.dispose();
    }
    assertNoBrowserErrors();
  });
}, 90_000);

test('interleaved edits and pastes retain content at every Undo and Redo step', async () => {
  await withChromiumFixture('composer-paste-content-history', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId, content: 'Synthetic interleaved paste history', projectPath: integration.dirs.project,
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const textarea = page.locator('[data-composer] textarea');
    const editor = page.getByRole('textbox', { name: 'Formatted message' });
    const source = 'Intro\n\nlast';
    await selectMessageFormat(page, 'source');
    await textarea.fill(source);
    await selectMessageFormat(page, 'formatted');
    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.evaluate(text => navigator.clipboard.writeText(text), '\n\n* one\n* two');
    await page.keyboard.press('Control+V');
    const firstPaste = `${source}\n\n* one\n* two`;
    await browserExpect(textarea).toHaveValue(firstPaste);
    await browserExpect(editor.locator('li')).toHaveCount(2);
    await browserExpect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.locator(':scope > p').nth(1).click();
    await page.keyboard.press('End');
    // The corrected typo rebuilds a fragment without changing the displayed document.
    await page.keyboard.type('x');
    await page.keyboard.press('Backspace');
    await browserExpect(textarea).toHaveValue(firstPaste);
    await page.evaluate(text => navigator.clipboard.writeText(text), ' more');
    await page.keyboard.press('Control+V');
    const history = [source, firstPaste, firstPaste, `${source} more\n\n* one\n* two`];
    await browserExpect(editor.locator(':scope > p').nth(1)).toHaveText('last more');
    await browserExpect(editor).toHaveAttribute('contenteditable', 'true');
    await browserExpect(textarea).toHaveValue(history.at(-1)!);
    for (const value of history.slice(0, -1).reverse()) {
      await page.keyboard.press('Control+Z');
      await browserExpect(textarea).toHaveValue(value);
    }
    for (const value of history.slice(1)) {
      await page.keyboard.press('Control+y');
      await browserExpect(textarea).toHaveValue(value);
    }
    assertNoBrowserErrors();
  });
}, 90_000);

test('pending raw paste keeps keyboard focus and respects outside scrolling', async () => {
  await withChromiumFixture('composer-paste-focus', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId, content: 'Synthetic paste focus', projectPath: integration.dirs.project,
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const composer = page.locator('[data-composer]');
    const textarea = composer.locator('textarea');
    const editor = page.getByRole('textbox', { name: 'Formatted message' });
    const source = Array.from({ length: 24 }, (_, index) => `Paragraph ${index}`).join('\n\n');
    const outside = page.getByRole('button', { name: 'New Chat', exact: true });
    const worker = '**/composer-markdown.worker-*.js';
    for (const scenario of ['mapped', 'unmapped', 'outside']) {
      await selectMessageFormat(page, 'source');
      await textarea.fill(source);
      await selectMessageFormat(page, 'formatted');
      await editor.focus();
      await page.keyboard.press('Control+End');
      const release = Promise.withResolvers<void>();
      await context.route(worker, async route => { await release.promise; await route.continue(); });
      const clipboard = scenario === 'unmapped' ? '\n\n- item\n\n' : ' **pasted**';
      await page.evaluate(text => navigator.clipboard.writeText(text), clipboard);
      await page.keyboard.press('Control+V');
      await browserExpect(editor).toHaveAttribute('contenteditable', 'false');
      if (scenario === 'outside') {
        await outside.dispatchEvent('pointerdown');
        await outside.focus();
        await composer.locator('[data-composer-markdown-editor]').evaluate(element => { element.scrollTop = 0; });
      } else {
        await page.keyboard.press('Shift');
        await browserExpect(editor).toBeFocused();
      }
      release.resolve();
      await browserExpect(composer.getByRole('button', { name: 'Pasting text...' })).toHaveCount(0);
      await context.unroute(worker);
      if (scenario === 'outside') {
        await browserExpect(outside).toBeFocused();
        expect(await composer.locator('[data-composer-markdown-editor]').evaluate(element => element.scrollTop)).toBe(0);
      } else {
        await browserExpect(scenario === 'mapped' ? editor : textarea).toBeFocused();
        await page.keyboard.type('y');
        await browserExpect(textarea).toHaveValue(source + clipboard + 'y');
      }
    }
    assertNoBrowserErrors();
  });
}, 90_000);

test("editable Markdown tables preserve drafts, focus, submission, and responsive layout", async () => {
  await withChromiumFixture(
    "composer-markdown",
    async ({ page, context, integration, assertNoBrowserErrors }) => {
      const ids = [integration.newChatId(), integration.newChatId()];
      for (const [index, chatId] of ids.entries()) {
        const turn = await integration.client.startDirectChat({
          chatId,
          content: `Synthetic composer review ${index}`,
          projectPath: integration.dirs.project,
          agent: integration.directAgents.anthropic,
        });
        await integration.client.waitForTurnTerminal(chatId, turn.turnId);
        await integration.client.waitForProcessing(chatId, false);
      }
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const snippets =
        await integration.client.get<SnippetsSnapshot>("/api/v1/snippets");
      await integration.client.post("/api/v1/snippets", {
        expectedRevision: snippets.revision,
        snippet: {
          shortName: "review",
          template: " appended snippet",
          defaultArguments: "",
        },
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
      const textarea = page.getByPlaceholder("Reply...", { exact: true });
      const editor = page.getByRole("textbox", { name: "Formatted message" });
      const selectFirstCellEnd = async () => {
        await editor.evaluate(element => {
          const paragraph = element.querySelector('td p');
          if (!paragraph) throw new Error('Expected a table cell paragraph');
          const rich = (element as HTMLElement & { editor: {
            view: { posAtDOM(node: Node, offset: number): number };
            commands: { setTextSelection(position: number): void; unsetBold(): void };
          } }).editor;
          // End targets a visual line in wrapped cells, not the paragraph boundary.
          rich.commands.setTextSelection(rich.view.posAtDOM(paragraph, paragraph.childNodes.length));
          rich.commands.unsetBold();
        });
      };
      const format = async () => {
        await selectMessageFormat(page, 'formatted');
        await editor.focus();
        await browserExpect(editor).toBeFocused();
      };
      const paste = async (text: string) => {
        await page.evaluate(
          (value) => navigator.clipboard.writeText(value),
          text,
        );
        await page.keyboard.press("Control+V");
      };
      const artifacts = join(import.meta.dirname, "../../artifacts/chromium");
      await mkdir(artifacts, { recursive: true });
      const screenshot = async (name: string) => {
        await page.locator("[data-composer-markdown-editor]").evaluate(element => {
          element.scrollTop = 0;
          element.scrollLeft = 0;
        });
        await page.screenshot({ path: join(artifacts, name) });
      };
      const clear = async () => {
        await selectMessageFormat(page, 'source');
        await textarea.evaluate((element: HTMLTextAreaElement) => {
          element.value = "";
          element.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await browserExpect(textarea).toBeVisible();
        await browserExpect(textarea).toHaveValue("");
        await textarea.focus();
      };
      const prose = "Ship **two** things:\n\n1. first\n2. second\n\n- [ ] follow up";
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await clear();
        await textarea.focus();
        await page.keyboard.type("Ship **two**");
        await browserExpect(editor).toHaveCount(0);
        await format();
        await browserExpect(editor).toBeFocused();
        await browserExpect(editor.locator("strong")).toHaveText("two");
        await page.keyboard.type(" and **three** now");
        await browserExpect(editor.locator("strong")).toHaveCount(2);
        await browserExpect(textarea).toHaveValue("Ship **two** and **three** now");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("| Name | Value |");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("| --- | --- |");
        await browserExpect(editor.locator("table")).toHaveCount(1);
        await page.keyboard.press("Tab");
        await page.keyboard.type("Synthetic item");
        await page.keyboard.press("Tab");
        await page.keyboard.type("Ready");
        await browserExpect(editor.locator("td")).toHaveCount(2);
        await browserExpect(textarea).toHaveValue(/Ship \*\*two\*\* and \*\*three\*\* now[\s\S]*Synthetic item.*Ready/);
        await screenshot(`composer-live-markdown-${width}.png`);
        await clear();
        await page.keyboard.type(`1. first ${width}`);
        await format();
        await browserExpect(editor).toBeFocused();
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("second");
        await browserExpect(editor.locator("ol > li")).toHaveCount(2);
        await browserExpect(textarea).toHaveValue(`1. first ${width}\n2. second`);
        const typed = await textarea.inputValue();
        if (width === 390) await page.getByRole("button", { name: "Send message", exact: true }).click();
        else await editor.press("Enter");
        await integration.client.waitForCommittedUserInput(ids[0], typed);
        await browserExpect(textarea).toHaveValue("");
        await integration.client.waitForProcessing(ids[0], false);
        await browserExpect(editor).toBeFocused();
        await page.keyboard.type("| Name | Value |");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("| --- | --- |");
        await browserExpect(editor.locator("table")).toHaveCount(1);
        await browserExpect(page.getByRole("button", { name: "Format Markdown" })).toHaveCount(0);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await clear();
      await textarea.focus();
      await paste(prose);
      await format();
      await browserExpect(editor).toBeFocused();
      await browserExpect(editor.locator("strong")).toHaveText("two");
      await browserExpect(editor.locator("ol > li")).toHaveCount(2);
      await browserExpect(textarea).toHaveValue(prose);
      await browserExpect(
        page.getByRole("button", { name: "Edit Markdown source" }),
      ).toHaveCount(0);
      await screenshot("composer-markdown-prose-1440.png");
      // Entering Formatted establishes a new undo checkpoint, never a hidden mode switch.
      await page.keyboard.press("Control+Z");
      await browserExpect(editor).toBeFocused();
      await browserExpect(textarea).toHaveValue(prose);
      await editor.locator("ol > li").first().click();
      await page.keyboard.press("End");
      await page.keyboard.type(" step");
      await browserExpect(textarea).toHaveValue(
        prose.replace("1. first", "1. first step"),
      );
      await writeFile(
        join(integration.dirs.project, "mention-target.md"),
        "Synthetic mention target",
      );
      await page.keyboard.type(" @mention-t");
      await browserExpect(
        page.getByRole("option", { name: /mention-target\.md/ }),
      ).toBeVisible();
      await page.keyboard.press("Enter");
      await browserExpect(textarea).toHaveValue(
        prose.replace("1. first", "1. first step @mention-target.md "),
      );
      await browserExpect(editor).toBeFocused();
      await page.keyboard.type("done");
      await browserExpect(textarea).toHaveValue(
        prose.replace("1. first", "1. first step @mention-target.md done"),
      );
      // Slash commands explicitly hand off to the source-owned palette.
      await page.keyboard.press("Control+A");
      await page.keyboard.type("/");
      await browserExpect(editor).toHaveCount(0);
      await browserExpect(textarea).toBeFocused();
      await browserExpect(textarea).toHaveValue("/");
      await browserExpect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Backspace");
      await clear();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await clear();
        await textarea.focus();
        await paste(table);
        await format();
        await browserExpect(editor).toBeVisible();
        await browserExpect(editor).toBeFocused();
        await browserExpect(editor.locator("table")).toHaveCount(1);
        await browserExpect(textarea).toHaveValue(table);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await screenshot(`composer-markdown-${width}.png`);
        await selectFirstCellEnd();
        await page.keyboard.type(" edited");
        await browserExpect(textarea).toHaveValue(/\*\*Startup ready\*\* edited/);
        await browserExpect(textarea).toHaveValue(/`a  b`/);
        const edited = await textarea.inputValue();
        await clear();
        if (width === 390) {
          await textarea.fill(edited);
          await format();
          await browserExpect(editor).toBeVisible();
          await browserExpect(editor).toBeFocused();
          await selectFirstCellEnd();
          await page.keyboard.press("Control+B");
          await page.keyboard.press("Shift+Enter");
          await page.keyboard.type("next paragraph");
          await browserExpect(textarea).toHaveValue(
            /\*\*Startup ready\*\* edited<br>\*\*next paragraph\*\*/,
          );
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await clear();
      await textarea.fill("Prefix\n\n");
      await textarea.focus();
      await paste(table);
      await format();
      await browserExpect(editor).toBeFocused();
      await page.keyboard.type(" at end");
      await browserExpect(textarea).toHaveValue(
        /Prefix[\s\S]*Code.*a  b.*at end/,
      );
      // Input in the same task as focus must land at the caret, not the document start.
      await editor.evaluate((element: HTMLElement) => {
        element.blur();
        getSelection()?.removeAllRanges();
        element.focus();
        document.execCommand("insertText", false, " synced");
      });
      await browserExpect(textarea).toHaveValue(/`a  b` at end synced \|$/);
      await editor.locator("p").first().click();
      const beforeSnippet = await textarea.inputValue();
      await page.getByRole("button", { name: "Add to prompt" }).click();
      await page.getByRole("menuitem", { name: /Snippets/ }).click();
      await browserExpect(editor).toHaveCount(0);
      await browserExpect
        .poll(() =>
          textarea.evaluate(
            (element: HTMLTextAreaElement) => element.selectionStart,
          ),
        )
        .toBe(beforeSnippet.length);
      await page.getByRole("option", { name: /^review/ }).click();
      await browserExpect(textarea).toHaveValue(
        beforeSnippet + " appended snippet",
      );
      // A trigger typed after formatted content opens the palette, which replaces it in source.
      await clear();
      await textarea.focus();
      await page.keyboard.type("**context**");
      await format();
      await browserExpect(editor).toBeFocused();
      await browserExpect(editor.locator("strong")).toHaveText("context");
      await page.keyboard.type(" ;;");
      const palette = page.getByRole("dialog", {
        name: "Insert Snippet",
        exact: true,
      });
      await browserExpect(palette).toBeVisible();
      await browserExpect(editor).toHaveCount(0);
      await browserExpect(textarea).toHaveValue("**context** ;;");
      await page.keyboard.type("rev");
      await palette.getByRole("option", { name: /^review/ }).click();
      await browserExpect(textarea).toHaveValue(
        "**context**  appended snippet",
      );
      // Source stays literal, even when completed Markdown syntax settles.
      await clear();
      await textarea.focus();
      await page.keyboard.type("**Note*");
      await page.waitForTimeout(600);
      await browserExpect(editor).toHaveCount(0);
      await page.keyboard.type("*");
      await browserExpect(editor).toHaveCount(0);
      await format();
      await browserExpect(editor.locator("strong")).toHaveText("Note");
      await browserExpect(textarea).toHaveValue("**Note**");
      // Written delimiters and references survive an edit of their paragraph.
      await clear();
      await textarea.focus();
      await page.keyboard.type("edit __init__.py and &lt; in _private_");
      await format();
      await browserExpect(editor.locator("strong")).toHaveText("init");
      await page.keyboard.type(" now");
      await browserExpect(textarea).toHaveValue(
        "edit __init__.py and &lt; in _private_ now",
      );
      await clear();
      await textarea.focus();
      await page.keyboard.type("my_var is broken:");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("-");
      await page.waitForTimeout(600);
      await browserExpect(editor).toHaveCount(0);
      await page.keyboard.type(" first item");
      await format();
      await browserExpect(editor.locator("ul > li")).toHaveText("first item");
      await browserExpect(textarea).toHaveValue(
        "my_var is broken:\n- first item",
      );
      await clear();
      await textarea.fill("plain notes");
      await paste("\nplain notes");
      await browserExpect(editor).toHaveCount(0);
      await browserExpect(textarea).toBeFocused();
      const large = "synthetic log entry\n".repeat(55_189);
      await clear();
      await textarea.focus();
      const start = performance.now();
      await paste(large);
      await browserExpect
        .poll(() => textarea.inputValue().then((value) => value.length))
        .toBe(large.length);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const elapsed = performance.now() - start;
      console.log(
        `Large paste and animation frames: ${Math.round(elapsed)} ms`,
      );
      expect(elapsed).toBeLessThan(3_000);
      await browserExpect(editor).toHaveCount(0);
      await browserExpect(textarea).toBeFocused();
      await clear();
      await textarea.focus();
      await paste(table);
      await format();
      await browserExpect(editor).toBeFocused();
      await editor.locator("td").first().click();
      const richStart = performance.now();
      await paste(large);
      await browserExpect(editor).toHaveCount(0);
      await browserExpect(textarea).toBeFocused();
      expect(
        (await textarea.inputValue()).includes("synthetic log entry<br>"),
      ).toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      console.log(
        `Large formatted paste to source: ${Math.round(performance.now() - richStart)} ms`,
      );
      expect(performance.now() - richStart).toBeLessThan(3_000);
      for (const prefix of ["> ", "  "]) {
        const nested =
          (prefix === "  " ? "- Review\n\n" : "") +
          table
            .split("\n")
            .map((line) => prefix + line)
            .join("\n");
        await clear();
        await textarea.focus();
        await paste(nested);
        await format();
        await browserExpect(editor.locator("table")).toHaveCount(1);
        await browserExpect(textarea).toHaveValue(nested);
      }
      const draft = await textarea.inputValue();
      const selectChat = async (id: string) => {
        await page
          .locator(`[data-sidebar-virtual-row="${id}"]`)
          .locator("button")
          .first()
          .click();
        await page.waitForURL(`**/chat/${id}`);
      };
      // A table draft returns formatted, so the switch is measured between restored states.
      await selectChat(ids[1]);
      await browserExpect(editor).toHaveCount(1);
      await selectChat(ids[0]);
      await browserExpect(editor.locator("table")).toHaveCount(1);
      const composerElement = await page
        .locator("[data-composer]")
        .elementHandle();
      const bounds = await page.locator("[data-composer]").boundingBox();
      for (const id of [ids[1], ids[0], ids[1], ids[0]]) {
        await selectChat(id);
        expect(
          await page.evaluate(
            (element) => document.querySelector("[data-composer]") === element,
            composerElement,
          ),
        ).toBe(true);
        await browserExpect(editor).toHaveCount(1);
      }
      expect((await page.locator("[data-composer]").boundingBox())?.y).toBe(
        bounds?.y,
      );
      await browserExpect(textarea).toHaveValue(draft);
      await page.reload();
      await browserExpect(editor.locator("table")).toHaveCount(1);
      await browserExpect(textarea).toHaveValue(draft);
      await clear();
      await textarea.focus();
      await paste(table);
      await format();
      await browserExpect(editor).toBeFocused();
      await editor.locator("td").first().click();
      await page.keyboard.press("End");
      await page.keyboard.type(" submitted");
      const submitted = await textarea.inputValue();
      await editor.press("Enter");
      await integration.client.waitForCommittedUserInput(ids[0], submitted);
      await browserExpect(textarea).toHaveValue("");
      await browserExpect(editor).toHaveCount(1);
      await integration.client.waitForProcessing(ids[0], false);
      await page.emulateMedia({ colorScheme: "dark" });
      await browserExpect(page.locator("html")).toHaveClass(/dark/);
      await clear();
      await textarea.focus();
      await paste(table);
      await format();
      await browserExpect(editor).toBeFocused();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await screenshot(`composer-markdown-dark-${width}.png`);
        await editor.locator("td").last().scrollIntoViewIfNeeded();
        await browserExpect(editor.locator("td").last()).toBeInViewport();
        await editor.locator("td").first().scrollIntoViewIfNeeded();
      }
      assertNoBrowserErrors();
    },
  );
}, 180_000);

test("formatted newline intent escapes containers under either submission preference", async () => {
  await withChromiumFixture("composer-newline", async ({ page, context, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId, content: "Synthetic newline review", projectPath: integration.dirs.project,
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const textarea = page.locator('[data-composer] textarea');
    const editor = page.getByRole('textbox', { name: 'Formatted message' });
    const open = async (source: string) => {
      await selectMessageFormat(page, 'source');
      await textarea.fill(source);
      await selectMessageFormat(page, 'formatted');
      await editor.focus();
      await browserExpect(editor).toBeFocused();
    };
    for (const sendByShiftEnter of [false, true]) {
      await page.evaluate((sendByShiftEnter) => {
        const key = 'pref_local_settings';
        const value = JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), sendByShiftEnter });
        localStorage.setItem(key, value);
        dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea: localStorage }));
      }, sendByShiftEnter);
      const newline = sendByShiftEnter ? 'Enter' : 'Shift+Enter';
      for (const [source, count, expected] of [
        ['> abc', 2, '> abc\n\noutside'],
        ['- item', 2, '- item\n\noutside'],
        ['1. item', 2, '1. item\n\noutside'],
        ['- [ ] task', 2, '- [ ] task\n\noutside'],
        ['# Title', 1, '# Title\n\noutside'],
        ['> - item', 3, '> - item\n\noutside'],
        ['```js\nlet a\n```', 1, '```js\nlet a\noutside\n```'],
        ['```js\nlet a\n```', 3, '```js\nlet a\n```\n\noutside'],
      ] as const) {
        await open(source);
        for (let index = 0; index < count; index++) await editor.press(newline);
        await page.keyboard.type('outside');
        await browserExpect(textarea).toHaveValue(expected);
      }
      for (const prefix of ['- ', '- [ ] ']) {
        await open(prefix + 'abcdefgh');
        const selected = await editor.evaluate((element) => {
          const rich = (element as HTMLElement & { editor: {
            state: { selection: { from: number }; doc: { textBetween(from: number, to: number): string } };
            commands: { setTextSelection(range: { from: number; to: number }): void };
          } }).editor;
          const end = rich.state.selection.from;
          rich.commands.setTextSelection({ from: end - 6, to: end - 4 });
          return rich.state.doc.textBetween(end - 6, end - 4);
        });
        expect(selected).toBe('cd');
        await editor.press(newline);
        await browserExpect(textarea).toHaveValue(`${prefix}ab\n${prefix}efgh`);
      }
      await open('> abc');
      await editor.press(newline);
      await editor.press(newline);
      await page.keyboard.type('submitted');
      await editor.press(sendByShiftEnter ? 'Shift+Enter' : 'Enter');
      await integration.client.waitForCommittedUserInput(chatId, '> abc\n\nsubmitted');
      await integration.client.waitForProcessing(chatId, false);
      await browserExpect(editor).toHaveCount(1);
    }
    await open('- [ ] same tick');
    const submittedBeforeReplay = (await integration.client.getMessages(chatId)).messages.filter(row => row.message.type === 'user-message').length;
    await editor.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await browserExpect(editor.locator('li')).toHaveCount(2);
    expect((await integration.client.getMessages(chatId)).messages.filter(row => row.message.type === 'user-message').length).toBe(submittedBeforeReplay);
    await open('- [ ] same tick');
    await editor.evaluate((element) => {
      element.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      element.closest('form')!.requestSubmit();
    });
    await integration.client.waitForCommittedUserInput(chatId, '- [x] same tick');
    await integration.client.waitForProcessing(chatId, false);
    const largeTable = '| Row | Text |\n| --- | --- |\n' + Array.from({ length: 150 }, (_, index) =>
      `| ${index} | ${'sample '.repeat(22)} |`,
    ).join('\n');
    await open(largeTable);
    const timings = await editor.evaluate(async (element) => {
      const mounted = element as HTMLElement & { editor: { commands: { insertContent(text: string): void } } };
      const times: number[] = [];
      for (let index = 0; index < 40; index++) {
        const start = performance.now();
        mounted.editor.commands.insertContent('x');
        times.push(performance.now() - start);
        await new Promise(requestAnimationFrame);
      }
      times.sort((a, b) => a - b);
      return { median: times[20], p95: times[38] };
    });
    console.log('Synchronous 150-row edits (ms):', timings);
    await browserExpect(textarea).toHaveValue(/x{40}/);
    await open('**composition**');
    const submittedBeforeComposition = (await integration.client.getMessages(chatId)).messages.filter(row => row.message.type === 'user-message').length;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'draft', selectionStart: 5, selectionEnd: 5 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
    await cdp.send('Input.insertText', { text: 'draft' });
    await browserExpect(textarea).toHaveValue(/composition.*draft/);
    expect((await textarea.inputValue()).match(/draft/g)).toHaveLength(1);
    expect((await integration.client.getMessages(chatId)).messages.filter(row => row.message.type === 'user-message').length).toBe(submittedBeforeComposition);
    await cdp.detach();
    await selectMessageFormat(page, 'source');
    await textarea.fill('> source remains literal');
    await page.reload();
    await browserExpect(textarea).toHaveValue('> source remains literal');
    await browserExpect(editor).toHaveCount(0);
    assertNoBrowserErrors();
  });
}, 180_000);

test("literal Shell input is formatted only in a mode that declares Markdown input", async () => {
  await withChromiumFixture(
    "composer-markdown-literal",
    async ({ page, integration, assertNoBrowserErrors }) => {
      const { client, executionDirs } = integration;
      const start = async (model: string, command: string) => {
        const chatId = integration.newChatId();
        const started = await client.startChat({
          chatId,
          agentId: "shell",
          model,
          projectPath: executionDirs.project,
          permissionMode: "default",
          thinkingMode: "none",
          agentSettings: { ownerId: "shell", schemaVersion: 1, values: {} },
          origin: "interactive",
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          command,
        });
        await client.waitForTurnTerminal(chatId, started.turnId);
        await client.waitForProcessing(chatId, false);
        return chatId;
      };
      const commandChat = await start("sh", "printf 'synthetic start'");
      const notesChat = await start("notes-markdown", "Synthetic note");
      const textarea = page.locator("[data-composer] textarea");
      const editor = page.getByRole("textbox", { name: "Formatted message" });
      const selectChat = async (id: string) => {
        await page
          .locator(`[data-sidebar-virtual-row="${id}"]`)
          .locator("button")
          .first()
          .click();
        await page.waitForURL(`**/chat/${id}`);
      };

      await page.goto(`${integration.garcon.baseUrl}/chat/${commandChat}`);
      await textarea.focus();
      const command = "printf '%s\\n' _target_";
      await page.keyboard.type(command);
      // Literal targets never offer formatted editing, even after typing settles.
      await page.waitForTimeout(600);
      await browserExpect(editor).toHaveCount(0);
      await page.keyboard.type(" __init__.py");
      await page.waitForTimeout(600);
      await browserExpect(editor).toHaveCount(0);
      await browserExpect(textarea).toHaveValue(`${command} __init__.py`);

      // A restored draft follows the mode of the chat it belongs to.
      await selectChat(notesChat);
      await browserExpect(textarea).toHaveValue("");
      await browserExpect(textarea).toBeFocused();
      await page.keyboard.type("Keep **this** and _target_");
      await browserExpect(textarea).toHaveValue("Keep **this** and _target_");
      await selectMessageFormat(page, 'formatted');
      await editor.focus();
      await browserExpect(editor).toBeFocused();
      await browserExpect(editor.locator("strong")).toHaveText("this");
      await browserExpect(editor.locator("em")).toHaveText("target");
      await selectChat(commandChat);
      await browserExpect(editor).toHaveCount(0);
      await browserExpect(textarea).toHaveValue(`${command} __init__.py`);
      await selectChat(notesChat);
      await browserExpect(editor.locator("strong")).toHaveText("this");
      await selectChat(commandChat);
      await browserExpect(editor).toHaveCount(0);

      await textarea.press("Enter");
      await browserExpect(textarea).toHaveValue("");
      await browserExpect
        .poll(async () =>
          (await client.getMessages(commandChat)).messages.flatMap((row) =>
            row.message.type === "user-message" ? [row.message.content] : [],
          ),
        )
        .toContain(`${command} __init__.py`);
      await browserExpect(
        page.locator(".markdown-code-block pre").filter({ hasText: "_target_" }),
      ).toBeVisible();
      assertNoBrowserErrors();
    },
  );
}, 120_000);
