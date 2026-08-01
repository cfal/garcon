import { describe, expect, test } from "bun:test";
import { withE2eFixture, type E2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

const ADDRESS_INPUT = "[data-browser-surface-form] input";
const FRAME = "[data-browser-surface-frame]";

async function submitAddress(
  fixture: E2eFixture,
  app: SpaDriver,
  value: string,
): Promise<void> {
  await app.fill(ADDRESS_INPUT, value);
  await fixture.page.$eval("[data-browser-surface-form]", (form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("Lightpanda browser surface", () => {
  test("opens the Browser surface, embeds cross-origin pages, and refuses the app origin", async () => {
    const embedTarget = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<!doctype html><title>embed target</title>ok", {
          headers: { "Content-Type": "text/html" },
        }),
    });
    try {
      await withE2eFixture("browser-surface", async (fixture) => {
        await fixture.page.setViewport({ width: 1_440, height: 900 });
        const app = new SpaDriver(fixture.page, fixture.integration);
        await app.open();
        await fixture.waitForSpaWebSocket();

        await app.openWorkspaceActions("main");
        await app.clickMenuItem("Open Browser");
        await fixture.page.waitForFunction(
          (selector) => Boolean(document.querySelector(selector)),
          { timeout: 20_000 },
          ADDRESS_INPUT,
        );

        const target = `http://127.0.0.1:${embedTarget.port}/`;
        await submitAddress(fixture, app, target);
        await fixture.page.waitForFunction(
          ({ selector, expected }) => {
            const frame = document.querySelector(selector);
            const sandbox = frame?.getAttribute("sandbox") ?? "";
            return (
              frame?.getAttribute("src") === expected &&
              sandbox.includes("allow-scripts") &&
              sandbox.includes("allow-same-origin") &&
              !sandbox.includes("allow-top-navigation") &&
              !sandbox.includes("allow-popups-to-escape-sandbox") &&
              frame?.getAttribute("referrerpolicy") === "no-referrer"
            );
          },
          { timeout: 20_000 },
          { selector: FRAME, expected: target },
        );

        const appOrigin = await fixture.page.evaluate(() => window.location.origin);
        await submitAddress(fixture, app, `${appOrigin}/chat`);
        await fixture.page.waitForFunction(
          () => Boolean(document.querySelector('[role="alert"]')),
          { timeout: 20_000 },
        );
        expect(
          await fixture.page.evaluate(
            (selector) => document.querySelector(selector)?.getAttribute("src"),
            FRAME,
          ),
        ).toBe(target);

        fixture.assertNoBrowserErrors();
      });
    } finally {
      embedTarget.stop(true);
    }
  });
});
