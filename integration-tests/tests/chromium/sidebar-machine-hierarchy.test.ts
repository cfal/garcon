import { test } from "bun:test";
import { expect } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { collapseCanonicalFilesWindow } from "../../support/chromium-workspace.js";
import type { ChatListResponse } from "../../../common/chat-list.js";
import type { ExecutorSnapshot } from "../../../common/executors.js";

test("machine hierarchy keeps project ownership clear on desktop and mobile", async () => {
  const baseline = process.env.GARCON_MACHINE_BASELINE === "1";
  await withChromiumFixture(
    "sidebar-machine-hierarchy",
    async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const { client, directAgents, executionDirs } = integration;
      const agent = directAgents.openAi;
      await client.put(
        `/api/v1/api-provider-assignments?executorId=local&apiProviderId=${agent.provider.providerId}`,
        {},
      );
      await client.patch(`/api/v1/executors/${client.executorId}`, {
        label: "Studio server",
      });
      const ids = [integration.newChatId(), integration.newChatId()];
      for (const [index, chatId] of ids.entries()) {
        const turn = await client.startDirectChat({
          chatId,
          content: "Synthetic machine navigation fixture",
          executorId: index === 0 ? "local" : client.executorId,
          projectPath:
            index === 0 ? integration.dirs.project : executionDirs.project,
          agent,
        });
        await client.waitForTurnTerminal(chatId, turn.turnId);
      }
      const listed = await client.get<ChatListResponse>("/api/v1/chats");
      const live = listed.sessions.find((chat) => chat.id === ids[0])!;
      const { executors: workers } = await client.get<{
        executors: ExecutorSnapshot[];
      }>("/api/v1/executors");
      const worker = workers.find(
        (executor) => executor.id === client.executorId,
      )!;
      const buildId = "33333333-3333-4333-8333-333333333333";
      const designId = "44444444-4444-4444-8444-444444444444";
      const executors = [
        ...workers,
        {
          ...worker,
          id: buildId,
          label: "Build server",
          availability: "offline",
          bulk: { availability: "offline", lastError: null },
        },
        {
          ...worker,
          id: designId,
          label: "Design lab",
          availability: "reconnecting",
          bulk: { availability: "reconnecting", lastError: null },
        },
      ];
      const definitions = [
        ["local", "/workspace/aurora", "Plan the next release"],
        ["local", "/workspace/aurora", "Review navigation changes"],
        ["local", "/workspace/notes", "Team workspace notes"],
        [client.executorId, "/workspace/aurora", "Run the deployment checks"],
        [
          client.executorId,
          "/workspace/aurora",
          "Investigate build performance",
        ],
        [client.executorId, "/workspace/atlas", "Review service logs"],
        [buildId, "/workspace/aurora", "Nightly build report"],
        [buildId, "/workspace/atlas", "Dependency updates"],
        [designId, "/Users/demo/projects/aurora", "Refine the mobile layout"],
        [designId, "/Users/demo/projects/library", "Review component spacing"],
      ];
      const sessions = definitions.map(
        ([executorId, projectPath, title], index) => ({
          ...live,
          id: String(9000000000000000 + index),
          executorId,
          projectPath,
          title,
          isUnread: index === 4,
          isPinned: false,
          activity: {
            ...live.activity,
            lastActivityAt: new Date(
              Date.now() - 3600000 * (index + 1),
            ).toISOString(),
          },
        }),
      );
      // Real chats remain available for navigation; synthetic rows exercise denser machine/project layouts.
      const snapshot = {
        ...listed,
        sessions: [...sessions, ...listed.sessions],
        total: sessions.length + listed.sessions.length,
      };
      await page.route("**/api/v1/chats", (route) =>
        route.fulfill({ json: snapshot }),
      );
      await page.route("**/api/v1/executors", (route) =>
        route.fulfill({ json: { executors } }),
      );
      await context.addInitScript(() =>
        localStorage.setItem(
          "pref_local_settings",
          JSON.stringify({
            allowDirectChats: true,
            sidebarGrouping: "project-and-activity",
            sidebarChatItemLayout: "single-line",
            sidebarSortMode: "manual",
          }),
        ),
      );
      phase("render desktop machine tree");
      await page.setViewportSize({ width: 1440, height: 1120 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
      await collapseCanonicalFilesWindow(page);
      const artifacts =
        process.env.GARCON_SCREENSHOT_DIR ??
        join(import.meta.dirname, "../../artifacts/chromium/machine-hierarchy");
      await mkdir(artifacts, { recursive: true });
      if (!baseline) {
        await expect(page.locator("[data-sidebar-machine-header]")).toHaveCount(
          4,
        );
        await expect(
          page.getByRole("button", {
            name: "Studio server, Ready",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Build server, Offline",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Design lab, Reconnecting",
            exact: true,
          }),
        ).toBeVisible();
        const studio = page.locator(
          `[data-sidebar-machine-header="${client.executorId}"]`,
        );
        await studio.click();
        await expect(studio).toHaveAttribute("aria-expanded", "false");
        await expect(
          page.getByText("Run the deployment checks", { exact: true }),
        ).toHaveCount(0);
        await page.reload();
        await expect(studio).toHaveAttribute("aria-expanded", "false");
        await studio.focus();
        await page.keyboard.press("Enter");
        await expect(
          page.getByText("Run the deployment checks", { exact: true }),
        ).toBeVisible();
      }
      await page.screenshot({
        path: join(
          artifacts,
          baseline ? "before-desktop.png" : "after-desktop.png",
        ),
      });
      await page.locator("[data-workspace-chat-list]").screenshot({
        path: join(
          artifacts,
          baseline ? "before-sidebar.png" : "after-sidebar.png",
        ),
      });
      phase("check navigation and retained draft");
      const composer = page.locator("[data-composer] textarea:visible");
      await composer.fill("Retained machine navigation draft");
      for (const chatId of [ids[1], ids[0], ids[1], ids[0]]) {
        await page.locator(`[data-sidebar-virtual-row="${chatId}"]`).click();
        await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
      }
      await expect(composer).toHaveValue("Retained machine navigation draft");
      phase("render mobile machine tree");
      await composer.blur();
      await expect(composer).not.toBeFocused();
      await page.setViewportSize({ width: 390, height: 900 });
      await page.reload();
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Chats", exact: true });
      await expect(drawer).toBeVisible();
      if (!baseline) {
        await expect(
          drawer.getByRole("button", { name: "Local, Ready", exact: true }),
        ).toBeVisible();
        await drawer
          .getByRole("button", { name: "Local, Ready", exact: true })
          .click();
        await expect(
          drawer.getByRole("button", { name: "Local, Ready", exact: true }),
        ).toHaveAttribute("aria-expanded", "false");
        await drawer
          .getByRole("button", { name: "Local, Ready", exact: true })
          .click();
      }
      await page.screenshot({
        path: join(
          artifacts,
          baseline ? "before-mobile.png" : "after-mobile.png",
        ),
      });
      assertNoBrowserErrors();
    },
    undefined,
    { executionBackend: "remote-controller-dials", projectRoots: "shared" },
  );
}, 180_000);
