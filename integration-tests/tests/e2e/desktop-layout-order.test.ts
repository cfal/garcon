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
          ].filter((pane) => {
            const rect = pane.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              getComputedStyle(pane).visibility !== "hidden"
            );
          });
          const paneIds = new Set(
            panes.map((pane) => pane.dataset.desktopLayoutPane),
          );
          const visibleOrder = order.filter((pane) => paneIds.has(pane));
          const visualOrder = panes.toSorted(
            (left, right) =>
              left.getBoundingClientRect().left -
              right.getBoundingClientRect().left,
          );
          return (
            panes.length === 2 &&
            visibleOrder.length === 2 &&
            panes.every(
              (pane, index) =>
                pane.dataset.desktopLayoutPane === visibleOrder[index],
            ) &&
            visualOrder.every(
              (pane, index) =>
                pane.dataset.desktopLayoutPane === visibleOrder[index],
            ) &&
            visualOrder.every((pane, index) => {
              const next = visualOrder[index + 1];
              return (
                !next ||
                pane.getBoundingClientRect().right <=
                  next.getBoundingClientRect().left + 1
              );
            })
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
          const mainRect = panes
            .find((pane) => pane.dataset.desktopLayoutPane === "main")!
            .getBoundingClientRect();
          const chatListRect = panes
            .find((pane) => pane.dataset.desktopLayoutPane === "chat-list")!
            .getBoundingClientRect();
          const workspaceSidebar = panes.find(
            (pane) => pane.dataset.desktopLayoutPane === "workspace-sidebar",
          )!;
          return (
            panes.length === 3 &&
            panes.every(
              (pane, index) => pane.dataset.desktopLayoutPane === order[index],
            ) &&
            mainRect.width > 0 &&
            chatListRect.width > 0 &&
            mainRect.right <= chatListRect.left + 1 &&
            workspaceSidebar.getAttribute("aria-hidden") === "false"
          );
        },
        { timeout: 20_000 },
        expected,
      );
      fixture.assertNoBrowserErrors();
    });
  });
});
