import { describe, expect, test } from "bun:test";
import { withE2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

describe("Lightpanda desktop layout order", () => {
  test("reorders desktop panes from Local Settings and restores the order after reload", async () => {
    await withE2eFixture("desktop-layout-order", async (fixture) => {
      await fixture.page.setViewport({ width: 1_440, height: 900 });
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.clickButton("More actions");
      await app.waitForMenuItemEnabled("Settings");
      await app.clickMenuItem("Settings");
      await app.waitForButton("Local Settings");
      await app.clickButton("Local Settings");
      await app.waitForButton("Move Main view up");
      await app.clickButton("Move Main view up");

      const expected = ["main", "chat-list", "workspace-sidebar"];
      await fixture.page.waitForFunction(
        (order) => {
          const panes = [
            ...document.querySelectorAll<HTMLElement>(
              "[data-desktop-layout-pane]",
            ),
          ];
          return (
            panes.length >= 2 &&
            panes
              .toSorted(
                (left, right) =>
                  Number(left.style.order) - Number(right.style.order),
              )
              .every(
                (pane, index) =>
                  pane.dataset.desktopLayoutPane === order[index],
              )
          );
        },
        { timeout: 20_000 },
        expected,
      );
      expect(
        await fixture.page.evaluate(() => {
          const raw = localStorage.getItem("pref_local_settings");
          return raw ? JSON.parse(raw).desktopLayoutOrder : null;
        }),
      ).toEqual(expected);

      const beforeReloadConnections =
        await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({
        afterConnectionCount: beforeReloadConnections,
      });
      await app.waitForButton("Open sidebar");
      await app.clickButton("Open sidebar");
      await fixture.page.waitForFunction(
        (order) => {
          const panes = [
            ...document.querySelectorAll<HTMLElement>(
              "[data-desktop-layout-pane]",
            ),
          ];
          return (
            panes.length === 3 &&
            panes
              .toSorted(
                (left, right) =>
                  Number(left.style.order) - Number(right.style.order),
              )
              .every(
                (pane, index) =>
                  pane.dataset.desktopLayoutPane === order[index],
              )
          );
        },
        { timeout: 20_000 },
        expected,
      );
      fixture.assertNoBrowserErrors();
    });
  });
});
