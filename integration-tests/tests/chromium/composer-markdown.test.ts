import { expect, test } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import type { SnippetsSnapshot } from "../../../common/snippets.js";

const table =
  "| Check | Example |\n| --- | --- |\n| **Startup ready** | Resolve earlier work before submitting. |\n| **Current data** | Use the latest observation.<br>Keep context current. |\n| **Code** | `a  b` |";

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
      // Emptying a formatted draft is the way back to the plain editor.
      const clear = async () => {
        if (await editor.isVisible()) {
          await editor.focus();
          await page.keyboard.press("Control+A");
          await page.keyboard.press("Backspace");
        } else await textarea.fill("");
        await browserExpect(textarea).toBeVisible();
        await browserExpect(textarea).toHaveValue("");
      };
      const prose = "Ship **two** things:\n\n1. first\n2. second\n\n- [ ] follow up";
      await textarea.focus();
      await paste(prose);
      await browserExpect(editor).toBeFocused();
      await browserExpect(editor.locator("strong")).toHaveText("two");
      await browserExpect(editor.locator("ol > li")).toHaveCount(2);
      await browserExpect(textarea).toHaveValue(prose);
      await browserExpect(
        page.getByRole("button", { name: "Edit Markdown source" }),
      ).toHaveCount(0);
      await screenshot("composer-markdown-prose-1440.png");
      // Undo straight after the paste steps out of the formatted view, then undoes the paste.
      await page.keyboard.press("Control+Z");
      await browserExpect(editor).toHaveCount(0);
      await browserExpect(textarea).toBeFocused();
      await browserExpect(textarea).toHaveValue(prose);
      await page.keyboard.press("Control+Z");
      await browserExpect(textarea).toHaveValue("");
      await paste(prose);
      await browserExpect(editor).toBeFocused();
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
      // A draft with no formatting left returns to the plain editor, where commands work.
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
        await editor.locator("td").first().click();
        await page.keyboard.press("End");
        await page.keyboard.type(" edited");
        await browserExpect(textarea).toHaveValue(/Startup ready.*edited/);
        await browserExpect(textarea).toHaveValue(/`a  b`/);
        const edited = await textarea.inputValue();
        await clear();
        await browserExpect(textarea).toBeFocused();
        if (width === 390) {
          await textarea.fill(edited);
          await page
            .getByRole("button", { name: "More composer actions" })
            .click();
          await page.getByRole("menuitem", { name: "Format Markdown" }).click();
          await browserExpect(editor).toBeVisible();
          await browserExpect(editor).toBeFocused();
          await editor.locator("td").first().locator("p").click();
          await browserExpect
            .poll(() => editor.evaluate(element => {
              const mounted = element as HTMLElement & {
                editor: { state: { selection: { $from: { parent: { textContent: string } } } } };
              };
              return mounted.editor.state.selection.$from.parent.textContent;
            }))
            .toBe("Startup ready edited");
          await page.keyboard.press("End");
          await page.keyboard.press("Shift+Enter");
          await page.keyboard.type("next paragraph");
          await browserExpect(textarea).toHaveValue(
            /\*\*Startup ready edited\*\*<br>\*\*next paragraph\*\*/,
          );
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await clear();
      await textarea.fill("Prefix\n\n");
      await textarea.focus();
      await paste(table);
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
      await browserExpect(textarea).toHaveValue(/a  b at end synced` \|$/);
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
      await textarea.fill(table);
      await textarea.focus();
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
      await browserExpect(editor).toHaveCount(0);
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
        await browserExpect(editor).toHaveCount(id === ids[0] ? 1 : 0);
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
      await browserExpect(editor).toBeFocused();
      await editor.locator("td").first().click();
      await page.keyboard.press("End");
      await page.keyboard.type(" submitted");
      const submitted = await textarea.inputValue();
      await editor.press("Enter");
      await integration.client.waitForCommittedUserInput(ids[0], submitted);
      await browserExpect(textarea).toHaveValue("");
      await browserExpect(editor).toHaveCount(0);
      await integration.client.waitForProcessing(ids[0], false);
      await page.emulateMedia({ colorScheme: "dark" });
      await browserExpect(page.locator("html")).toHaveClass(/dark/);
      await clear();
      await textarea.focus();
      await paste(table);
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
