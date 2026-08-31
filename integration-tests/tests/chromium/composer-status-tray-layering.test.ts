import { describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";
import {
  withChromiumFixture,
  type ChromiumFixture,
} from "../../support/chromium-fixture.js";
import { withTimeout } from "../../support/deferred.js";

const COMPOSER_SURFACE = "[data-composer]";
const COMPOSER_SHELL = "[data-composer-shell]";
const CONVERSATION_PANEL = "[data-conversation-panel]";
const PROCESSING_STATUS = '[data-slot="chat-processing-status"]';

type Rgba = [number, number, number, number];

async function openSettledChat(fixture: ChromiumFixture): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content: "composer-status-tray-prime",
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
  await fixture.page.locator(COMPOSER_SURFACE).waitFor({ state: "visible" });
  return chatId;
}

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Missing composer status tray geometry.");
  return box;
}

async function samplePixel(page: Page, x: number, y: number): Promise<Rgba> {
  const screenshot = await page.screenshot({
    animations: "disabled",
    clip: {
      x: Math.floor(x),
      y: Math.floor(y),
      width: 2,
      height: 2,
    },
  });
  return page.evaluate(
    async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas context is unavailable.");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const totals = [0, 0, 0, 0];
      const pixelCount = pixels.length / 4;
      for (let index = 0; index < pixels.length; index += 4) {
        totals[0] += pixels[index] ?? 0;
        totals[1] += pixels[index + 1] ?? 0;
        totals[2] += pixels[index + 2] ?? 0;
        totals[3] += pixels[index + 3] ?? 0;
      }
      return totals.map((total) => Math.round(total / pixelCount)) as Rgba;
    },
    `data:image/png;base64,${screenshot.toString("base64")}`,
  );
}

function maximumChannelDifference(left: Rgba, right: Rgba): number {
  return Math.max(
    ...left.map((channel, index) => Math.abs(channel - right[index]!)),
  );
}

describe("Chromium composer status tray layering", () => {
  test("keeps the processing cap visible underneath the rounded composer corners", async () => {
    await withChromiumFixture(
      "composer-status-tray-layering",
      async (fixture, markPhase) => {
        markPhase("opening a settled chat");
        const chatId = await openSettledChat(fixture);
        const prompt = "composer-status-tray-held";
        const held = fixture.integration.fakeProviders.openAi.holdNext({
          lastUserText: prompt,
        });
        let turnId: string | null = null;

        try {
          markPhase("holding a processing turn");
          const accepted = await fixture.integration.client.runDirectChat({
            chatId,
            content: prompt,
            agent: fixture.integration.directAgents.openAi,
          });
          turnId = accepted.turnId ?? null;
          await withTimeout(
            held.received,
            10_000,
            () => "Timed out waiting for the held processing turn.",
          );

          const status = fixture.page.locator(PROCESSING_STATUS);
          const composer = fixture.page.locator(COMPOSER_SURFACE);
          await status.waitFor({ state: "visible" });
          const [statusBox, composerBox] = await Promise.all([
            bounds(status),
            bounds(composer),
          ]);

          markPhase(
            "checking the shared underlap geometry and paint ownership",
          );
          const overlap = statusBox.y + statusBox.height - composerBox.y;
          expect(overlap).toBeGreaterThan(10);
          expect(overlap).toBeLessThan(14);
          expect(Math.abs(statusBox.x - composerBox.x)).toBeLessThan(1);
          expect(
            Math.abs(
              statusBox.x +
                statusBox.width -
                (composerBox.x + composerBox.width),
            ),
          ).toBeLessThan(1);
          expect(
            await fixture.page
              .locator(COMPOSER_SHELL)
              .evaluate((shell) => {
                const style = getComputedStyle(shell);
                return (
                  ["transparent", "rgba(0, 0, 0, 0)"].includes(
                    style.backgroundColor,
                  ) && style.backgroundImage === "none"
                );
              }),
          ).toBe(true);
          expect(
            await fixture.page
              .locator(CONVERSATION_PANEL)
              .evaluate((panel) => getComputedStyle(panel).backgroundColor),
          ).not.toBe("rgba(0, 0, 0, 0)");
          expect(
            await status.evaluate(
              (element) =>
                element.closest(".composer-thinking-active") !== null,
            ),
          ).toBe(true);

          markPhase(
            "sampling the visible cap below the composer's rounded corner",
          );
          const sampleX = composerBox.x + 2;
          const visibleCapPixel = await samplePixel(
            fixture.page,
            sampleX,
            composerBox.y - 4,
          );
          const underlapPixel = await samplePixel(
            fixture.page,
            sampleX,
            composerBox.y + 2,
          );
          const backdropPixel = await samplePixel(
            fixture.page,
            composerBox.x - 4,
            composerBox.y + 2,
          );
          expect(
            maximumChannelDifference(underlapPixel, visibleCapPixel),
          ).toBeLessThanOrEqual(2);
          expect(
            maximumChannelDifference(underlapPixel, backdropPixel),
          ).toBeGreaterThan(5);
        } finally {
          held.releaseEcho();
        }

        if (turnId === null)
          throw new Error("The held processing turn was not accepted.");
        await fixture.integration.client.waitForTurnTerminal(chatId, turnId);
        fixture.assertNoBrowserErrors();
      },
    );
  });
});
