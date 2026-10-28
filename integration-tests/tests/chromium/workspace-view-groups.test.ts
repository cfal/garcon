import { describe, expect, test } from "bun:test";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { collapseCanonicalFilesWindow } from "../../support/chromium-workspace.js";
import { initializeFixtureRepository } from "../../support/git-fixture.js";

const CHAT_VIEWS = [
  { label: "Open Chat Map", kind: "chat-map" },
  { label: "Open Canvas", kind: "chat-canvas" },
  { label: "Open Chat Board", kind: "chat-board" },
] as const;
const GIT_VIEWS = [
  { label: "Open Git Workbench", kind: "git" },
  { label: "Open Git History", kind: "git-history" },
  { label: "Open Git Compare", kind: "git-compare" },
  { label: "Open Commit", kind: "commit" },
] as const;

describe("Chromium view-group navigation", () => {
  for (const heightDelta of [0, 6]) {
    test(`keeps groups stable across width boundaries with titlebar size +${heightDelta}`, async () => {
      await withChromiumFixture(
        `workspace-group-widths-${heightDelta}`,
        async ({ page, integration, assertNoBrowserErrors }) => {
          await page.context().addInitScript((delta) => {
            const preferences = JSON.parse(
              localStorage.getItem("pref_local_settings") ?? "{}",
            );
            localStorage.setItem(
              "pref_local_settings",
              JSON.stringify({
                ...preferences,
                workspaceWindowTitlebarHeightDeltaPx: delta,
              }),
            );
          }, heightDelta);
          const chatId = integration.newChatId();
          const started = await integration.client.startDirectChat({
            chatId,
            content: "Synthetic group widths",
            projectPath: integration.dirs.project,
            agent: integration.directAgents.openAi,
          });
          await integration.client.waitForTurnTerminal(chatId, started.turnId);
          await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
            waitUntil: "domcontentloaded",
          });
          await collapseCanonicalFilesWindow(page);
          const titlebar = page.locator(
            '[data-workspace-window-current="true"] [data-workspace-window-titlebar]',
          );
          const windowId = await titlebar.getAttribute(
            "data-workspace-window-titlebar",
          );
          const controls = titlebar.locator(
            "[data-workspace-window-add-controls]",
          );
          await controls
            .getByRole("button", { name: "New Terminal", exact: true })
            .waitFor();
          const geometry = await titlebar.evaluate((element) => {
            const tabs = element.querySelector<HTMLElement>(
              "[data-workspace-window-tabs]",
            )!;
            const controls = element.querySelector<HTMLElement>(
              "[data-workspace-window-add-controls]",
            )!;
            return {
              fixed:
                element.getBoundingClientRect().width -
                tabs.getBoundingClientRect().width -
                controls.getBoundingClientRect().width,
              natural: element
                .querySelector<HTMLElement>("[data-window-tab-measure-id]")!
                .getBoundingClientRect().width,
              control: controls.querySelector("button")!.getBoundingClientRect()
                .width,
            };
          });
          expect(geometry.control).toBe(28 + heightDelta);
          const order = [
            "git-views",
            "singleton:files",
            "singleton:tickets",
            "chat-views",
            "github-views",
            "new-terminal",
          ];
          const widthFor = (count: number) =>
            Math.ceil(
              geometry.fixed +
                geometry.natural +
                (count + 1) * geometry.control +
                count * 2,
            );
          async function setWidth(width: number): Promise<void> {
            await titlebar.evaluate((element, width) => {
              (element as HTMLElement).style.width = `${width}px`;
            }, width);
            let count = 0;
            for (let candidate = order.length; candidate >= 0; candidate -= 1) {
              const slots = candidate + (candidate < order.length ? 1 : 0);
              if (
                geometry.natural +
                  slots * geometry.control +
                  Math.max(0, slots - 1) * 2 <=
                width - geometry.fixed
              ) {
                count = candidate;
                break;
              }
            }
            await page.waitForFunction(
              ({ id, expected }) => {
                const controls = document.querySelector(
                  `[data-workspace-window-add-controls="${id}"]`,
                )!;
                return (
                  JSON.stringify(
                    [
                      ...controls.querySelectorAll<HTMLElement>(
                        "[data-workspace-window-add-inline]",
                      ),
                    ].map(
                      (element) => element.dataset.workspaceWindowAddInline,
                    ),
                  ) === JSON.stringify(expected)
                );
              },
              { id: windowId, expected: order.slice(0, count) },
            );
            const fits = await titlebar.evaluate((element) => {
              const tabs = element
                .querySelector("[data-workspace-window-tabs]")!
                .getBoundingClientRect();
              const controls = element
                .querySelector("[data-workspace-window-add-controls]")!
                .getBoundingClientRect();
              return (
                tabs.right <= controls.left + 0.5 &&
                controls.right <= element.getBoundingClientRect().right
              );
            });
            expect(fits).toBe(true);
          }
          for (const width of [
            220,
            280,
            widthFor(1) - 1,
            widthFor(1) + 1,
            500,
            650,
            900,
            650,
            500,
            280,
            220,
          ]) {
            await setWidth(width);
          }
          for (const group of [
            { id: "git-views", label: "Git Views", count: 1 },
            { id: "chat-views", label: "Chat Views", count: 4 },
          ]) {
            await setWidth(220);
            await controls
              .getByRole("button", { name: "Add to window", exact: true })
              .click();
            const submenu = page.getByRole("menuitem", {
              name: group.label,
              exact: true,
            });
            await submenu.focus();
            await page.keyboard.press("ArrowRight");
            const menu = page.locator(
              `[data-workspace-window-group-menu="${group.id}"]`,
            );
            await menu.getByRole("menuitem").first().focus();
            await setWidth(widthFor(group.count) + 1);
            await menu.waitFor({ state: "detached" });
            const trigger = controls.getByRole("button", {
              name: group.label,
              exact: true,
            });
            expect(
              await trigger.evaluate(
                (element) => element === document.activeElement,
              ),
            ).toBe(true);
            expect(
              await controls
                .getByRole("button", { name: "Add to window", exact: true })
                .count(),
            ).toBe(1);
            await trigger.click();
            await menu.getByRole("menuitem").first().focus();
            await setWidth(220);
            await menu.waitFor({ state: "detached" });
            expect(
              await controls
                .getByRole("button", { name: "Add to window", exact: true })
                .evaluate((element) => element === document.activeElement),
            ).toBe(true);
          }
          await titlebar.evaluate((element) => {
            (element as HTMLElement).style.marginLeft = "auto";
          });
          await controls
            .getByRole("button", { name: "Add to window", exact: true })
            .click();
          await page
            .getByRole("menuitem", { name: "Git Views", exact: true })
            .focus();
          await page.keyboard.press("ArrowRight");
          const gitMenu = page.locator(
            '[data-workspace-window-group-menu="git-views"]',
          );
          await gitMenu.waitFor({ state: "visible" });
          const bounds = await gitMenu.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
            page.viewportSize()!.width,
          );
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
            page.viewportSize()!.height,
          );
          expect(await gitMenu.getByRole("menuitem").count()).toBe(4);
          assertNoBrowserErrors();
        },
      );
    });
  }

  test("returns Escape focus to add-menu triggers created while the composer has focus", async () => {
    await withChromiumFixture(
      "workspace-add-menu-escape-focus",
      async ({ page, integration, assertNoBrowserErrors }) => {
        const chatId = integration.newChatId();
        const started = await integration.client.startDirectChat({
          chatId,
          content: "Synthetic add-menu focus",
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
          waitUntil: "domcontentloaded",
        });
        await collapseCanonicalFilesWindow(page);
        const titlebar = page.locator(
          '[data-workspace-window-current="true"] [data-workspace-window-titlebar]',
        );
        const composer = page.locator("[data-composer] textarea");
        for (const group of [
          "Git Views",
          "Chat Views",
          "GitHub Views",
          "Add to window",
        ]) {
          const overflow = group === "Add to window";
          await titlebar.evaluate((element, narrow) => {
            (element as HTMLElement).style.width = narrow ? "280px" : "";
          }, !overflow);
          await titlebar
            .getByRole("button", {
              name: overflow ? "Chat Views" : "Add to window",
              exact: true,
            })
            .waitFor();
          await composer.focus();
          await titlebar.evaluate((element, narrow) => {
            (element as HTMLElement).style.width = narrow ? "280px" : "";
          }, overflow);
          const trigger = titlebar.getByRole("button", {
            name: group,
            exact: true,
          });
          await trigger.waitFor();
          expect(
            await composer.evaluate(
              (element) => element === document.activeElement,
            ),
          ).toBe(true);
          await trigger.click();
          await page.getByRole("menuitem").first().focus();
          await page.keyboard.press("Escape");
          await page.getByRole("menu").waitFor({ state: "detached" });
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              ),
          );
          expect(
            await trigger.evaluate(
              (element) => element === document.activeElement,
            ),
          ).toBe(true);
        }
        assertNoBrowserErrors();
      },
    );
  });

  for (const { id, label, views } of [
    { id: "chat-views", label: "Chat Views", views: CHAT_VIEWS },
    { id: "git-views", label: "Git Views", views: GIT_VIEWS },
  ]) {
    for (const layout of ["overflow", "inline"] as const) {
      test(`opens all ${label} from the ${layout} group and preserves focus on resize`, async () => {
        await withChromiumFixture(
          `workspace-${id}-${layout}`,
          async (fixture) => {
            const { page, integration } = fixture;
            if (id === "git-views") {
              await initializeFixtureRepository(integration.dirs.project);
            }
            const chatId = integration.newChatId();
            const started = await integration.client.startDirectChat({
              chatId,
              content: "Synthetic chat views navigation",
              projectPath: integration.dirs.project,
              agent: integration.directAgents.openAi,
            });
            await integration.client.waitForTurnTerminal(
              chatId,
              started.turnId,
            );
            await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
              waitUntil: "domcontentloaded",
            });
            await collapseCanonicalFilesWindow(page);
            const workspaceWindow = page.locator(
              '[data-workspace-window-current="true"]',
            );
            const windowId = await workspaceWindow.getAttribute(
              "data-workspace-window-id",
            );
            if (!windowId)
              throw new Error("Missing chat views workspace window.");
            const titlebar = page.locator(
              `[data-workspace-window-titlebar="${windowId}"]`,
            );
            const controls = titlebar.locator(
              "[data-workspace-window-add-controls]",
            );
            const viewsMenu = page.locator(
              `[data-workspace-window-add-menu="${windowId}"][data-workspace-window-group-menu="${id}"]`,
            );

            async function setLayout(
              next: "overflow" | "inline",
            ): Promise<void> {
              await titlebar.evaluate((element, mode) => {
                (element as HTMLElement).style.width =
                  mode === "overflow" ? "300px" : "";
              }, next);
              await controls
                .getByRole("button", {
                  name: next === "overflow" ? "Add to window" : label,
                  exact: true,
                })
                .waitFor();
            }

            async function openViews(): Promise<void> {
              if (layout === "overflow") {
                await controls
                  .locator("[data-workspace-window-add-trigger]")
                  .click();
                const submenu = page.getByRole("menuitem", {
                  name: label,
                  exact: true,
                });
                await submenu.focus();
                await page.keyboard.press("ArrowRight");
              } else {
                await controls
                  .getByRole("button", { name: label, exact: true })
                  .click();
              }
              await viewsMenu.waitFor({ state: "visible" });
            }

            await setLayout(layout);
            await page.locator("[data-composer] textarea").focus();
            await openViews();
            expect(
              (await viewsMenu.getByRole("menuitem").allTextContents()).map(
                (label) => label.trim(),
              ),
            ).toEqual(views.map((view) => view.label));
            await viewsMenu
              .getByRole("menuitem", { name: views[1].label, exact: true })
              .focus();
            const otherLayout = layout === "overflow" ? "inline" : "overflow";
            await setLayout(otherLayout);
            await page.waitForFunction(
              ({ windowId, groupId, mode }) => {
                const selector =
                  mode === "inline"
                    ? `[data-workspace-window-add-group-trigger="${groupId}"]`
                    : "[data-workspace-window-add-trigger]";
                return (
                  document.querySelector(
                    `[data-workspace-window-titlebar="${windowId}"] ${selector}`,
                  ) === document.activeElement
                );
              },
              { windowId, groupId: id, mode: otherLayout },
            );
            await viewsMenu.waitFor({ state: "detached" });
            await setLayout(layout);

            for (const [index, view] of views.entries()) {
              for (const candidate of views) {
                expect(
                  await controls
                    .getByRole("button", { name: candidate.label, exact: true })
                    .count(),
                ).toBe(0);
              }
              await openViews();
              expect(
                (await viewsMenu.getByRole("menuitem").allTextContents()).map(
                  (label) => label.trim(),
                ),
              ).toEqual(views.slice(index).map((candidate) => candidate.label));
              await viewsMenu
                .getByRole("menuitem", { name: view.label, exact: true })
                .click();
              await page
                .locator(
                  `[data-workspace-window-id="${windowId}"][data-workspace-window-active-surface="singleton:${view.kind}"]`,
                )
                .waitFor();
              await viewsMenu.waitFor({ state: "detached" });
            }
            expect(
              await controls
                .getByRole("button", { name: label, exact: true })
                .count(),
            ).toBe(0);
            await page.reload({ waitUntil: "domcontentloaded" });
            for (const view of views) {
              await page
                .locator(`[id="${windowId}-tab-singleton:${view.kind}"]`)
                .waitFor();
            }
            fixture.assertNoBrowserErrors();
          },
        );
      });
    }
  }
});
