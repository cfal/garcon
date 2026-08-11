import { describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";
import {
  withChromiumFixture,
  type ChromiumFixture,
} from "../../support/chromium-fixture.js";

const COMPOSER_TEXTAREA = "[data-composer] textarea";

async function openChat(fixture: ChromiumFixture): Promise<void> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content: "composer-resize-chromium",
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: "domcontentloaded" },
  );
  if (!response?.ok())
    throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await fixture.page.locator(COMPOSER_TEXTAREA).waitFor({ state: "visible" });
}

async function waitForInlineHeight(page: Page, height: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, expectedHeight }) =>
      document.querySelector<HTMLTextAreaElement>(selector)?.style.height ===
      `${expectedHeight}px`,
    { selector: COMPOSER_TEXTAREA, expectedHeight: height },
  );
}

async function renderedHeight(textarea: Locator): Promise<number> {
  const bounds = await textarea.boundingBox();
  if (!bounds) throw new Error("Missing composer textarea geometry.");
  return bounds.height;
}

describe("Chromium composer resizing", () => {
  test("renders every drag frame after content auto-growth and preserves the committed height", async () => {
    await withChromiumFixture(
      "composer-live-resize",
      async (fixture, markPhase) => {
        markPhase("opening a settled chat");
        await openChat(fixture);
        const textarea = fixture.page.locator(COMPOSER_TEXTAREA);
        const handle = fixture.page.getByRole("slider", {
          name: "Resize message composer",
        });

        markPhase("auto-growing the composer with a long draft");
        const longDraft = Array.from(
          { length: 24 },
          (_, index) => `Draft line ${index + 1}`,
        ).join("\n");
        await textarea.fill(longDraft);
        await waitForInlineHeight(fixture.page, 300);
        expect(await renderedHeight(textarea)).toBeCloseTo(300, 0);

        markPhase("shrinking the auto-grown composer with pointer capture");
        const handleBounds = await handle.boundingBox();
        if (!handleBounds)
          throw new Error("Missing composer resize handle geometry.");
        const pointerX = handleBounds.x + handleBounds.width / 2;
        const pointerY = handleBounds.y + handleBounds.height / 2;
        await fixture.page.mouse.move(pointerX, pointerY);
        await fixture.page.mouse.down();
        await fixture.page.mouse.move(pointerX, pointerY + 100, { steps: 8 });
        await waitForInlineHeight(fixture.page, 200);
        expect(await renderedHeight(textarea)).toBeCloseTo(200, 0);
        expect(
          await fixture.page.evaluate(() =>
            localStorage.getItem("composerHeight"),
          ),
        ).toBeNull();
        await fixture.page.mouse.up();

        await fixture.page.waitForFunction(
          () => localStorage.getItem("composerHeight") === "200",
        );
        expect(await renderedHeight(textarea)).toBeCloseTo(200, 0);

        markPhase("reloading the committed empty composer");
        await textarea.fill("");
        await waitForInlineHeight(fixture.page, 200);
        await fixture.page.reload({ waitUntil: "domcontentloaded" });
        await fixture.page
          .locator(COMPOSER_TEXTAREA)
          .waitFor({ state: "visible" });
        await waitForInlineHeight(fixture.page, 200);
        expect(
          await renderedHeight(fixture.page.locator(COMPOSER_TEXTAREA)),
        ).toBeCloseTo(200, 0);
        fixture.assertNoBrowserErrors();
      },
    );
  });
});
