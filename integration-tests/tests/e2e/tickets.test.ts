import { describe, expect, test } from "bun:test";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  parseTicketBootstrap,
  parseTicketDetail,
  parseTicketHistoryPage,
  parseTicketPage,
} from "../../../common/ticket-responses.js";
import { parseTicketWriteResult } from "../../../common/ticket-records.js";
import type { TicketMutationPayload } from "../../../common/ticket-commands.js";
import { withE2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

describe("Lightpanda Tickets", () => {
  test("closes field and comment editors after retrying committed writes with lost responses", async () => {
    await withE2eFixture("tickets-editor-retry", async (fixture) => {
      const bootstrap = parseTicketBootstrap(
        await fixture.integration.client.get("/api/v1/tickets/bootstrap"),
      );
      const mutate = (payload: TicketMutationPayload) =>
        fixture.integration.client.post("/api/v1/tickets/mutate", {
          requestId: crypto.randomUUID(),
          expectedStoreId: bootstrap.storeId,
          payload,
        });
      await mutate({
        action: "create",
        input: { title: "Original title", project: "Release" },
      });
      await mutate({
        action: "comment",
        ticketId: "G-1",
        body: "Original comment",
      });
      await fixture.page.evaluateOnNewDocument(() => {
        const nativeFetch = globalThis.fetch.bind(globalThis);
        const drop = new Set(["update", "comment-edit"]);
        globalThis.fetch = Object.assign(
          async (...args: Parameters<typeof fetch>) => {
            const response = await nativeFetch(...args);
            if (String(args[0]).endsWith("/tickets/mutate")) {
              const action = JSON.parse(String(args[1]?.body)).payload.action;
              if (drop.delete(action)) {
                await response.text();
                throw new TypeError("Synthetic lost editor response");
              }
            }
            return response;
          },
          { preconnect: globalThis.fetch.preconnect },
        );
      });
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.selectWorkspaceWindowSurface("Open Tickets");
      await fixture.page.waitForSelector('[data-ticket-id="G-1"]');
      await app.clickButton("Open G-1");
      await fixture.page.waitForSelector(".ticket-detail-title");
      for (const kind of ["fields", "comment"] as const) {
        await fixture.page.evaluate((kind) => {
          const editor = document.querySelector(
            kind === "fields" ? ".ticket-detail" : "[data-comment-id]",
          )!;
          const edit = [
            ...editor.querySelectorAll<HTMLButtonElement>("button"),
          ].find((button) => button.textContent?.trim() === "Edit");
          if (!edit) throw new Error("Missing editor action");
          edit.click();
        }, kind);
        const selector =
          kind === "fields"
            ? ".ticket-detail .ticket-title-input"
            : "[data-comment-id] textarea";
        await app.fill(
          selector,
          kind === "fields" ? "Retried title" : "Retried comment",
        );
        await app.clickButton("Save changes");
        await app.waitForText("Save not confirmed.");
        await fixture.page.evaluate(() => {
          const retry = [
            ...document.querySelectorAll<HTMLButtonElement>(
              ".ticket-detail button",
            ),
          ].find(
            (button) => button.textContent?.trim() === "Retry same request",
          );
          if (!retry) throw new Error("Missing editor retry action");
          retry.click();
        });
        await fixture.page.waitForFunction(
          (selector) => !document.querySelector(selector),
          {},
          selector,
        );
        await app.waitForText(
          kind === "fields" ? "Retried title" : "Retried comment",
        );
      }
      const detail = parseTicketDetail(
        await fixture.integration.client.get(
          "/api/v1/tickets/detail?ticketId=G-1",
        ),
      );
      expect(detail.ticket.title).toBe("Retried title");
      expect(detail.ticket.revision).toBe(2);
      expect(detail.comments.items[0]?.body).toBe("Retried comment");
      expect(detail.comments.items[0]?.revision).toBe(2);
      fixture.assertNoBrowserErrors();
    });
  });

  test("guards recovered old-store drafts after reload and after closing the surface", async () => {
    await withE2eFixture("tickets-old-store-recovery", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.selectWorkspaceWindowSurface("Open Tickets");
      await app.waitForText("No tickets yet");
      await app.clickButton("New ticket");
      await app.fill(
        '[role="dialog"] .ticket-title-input',
        "Synthetic retained old-store draft",
      );
      await fixture.page.waitForFunction(
        () =>
          Object.keys(sessionStorage).some((key) =>
            key.startsWith("garcon-ticket-draft-v1:"),
          ) &&
          localStorage
            .getItem("workspace_layout_v2")
            ?.includes('"kind":"tickets"'),
      );
      fixture.assertNoBrowserErrors();
      await fixture.integration.crashAndRestartGarcon({
        reusePort: true,
        beforeStart: async () => {
          const workspace = fixture.integration.dirs.workspace;
          const backup = join(workspace, "ticket-store-backup");
          await mkdir(backup);
          for (const file of await readdir(workspace)) {
            if (
              [
                "tickets.sqlite",
                "tickets.sqlite-wal",
                "tickets.sqlite-shm",
              ].includes(file)
            )
              await rename(join(workspace, file), join(backup, file));
          }
        },
      });
      await fixture.page.reload({ waitUntil: [] });
      await fixture.page.waitForSelector(".ticket-recovery summary");
      await fixture.page.evaluate(() =>
        document.querySelector<HTMLElement>(".ticket-recovery summary")!.click(),
      );
      await app.waitForText(
        "Draft from a previous ticket store. Copy its text before starting a new submission.",
      );
      const guarded = () =>
        fixture.page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        });
      expect(await guarded()).toBe(true);
      const windowId =
        await app.workspaceWindowIdForSurface("singleton:tickets");
      await app.openWorkspaceWindowActions(windowId);
      const closeSelector = `[data-workspace-window-menu="${windowId}"] [data-workspace-window-tab-action="close-tab"]`;
      await fixture.page.waitForSelector(closeSelector);
      await fixture.page.evaluate(
        (selector) => document.querySelector<HTMLElement>(selector)!.click(),
        closeSelector,
      );
      await app.waitForText("Close Tickets?");
      await app.clickDialogButton("Close Tickets");
      await fixture.page.waitForFunction(
        () => !document.querySelector(".tickets-surface"),
      );
      expect(await guarded()).toBe(true);
      await app.selectWorkspaceWindowSurface("Open Tickets");
      await fixture.page.waitForSelector(".ticket-recovery summary");
      await fixture.page.evaluate(() =>
        document.querySelector<HTMLElement>(".ticket-recovery summary")!.click(),
      );
      await app.waitForText(
        "Draft from a previous ticket store. Copy its text before starting a new submission.",
      );
      expect(
        fixture.browserErrors.filter(
          (message) => !message.startsWith("console.error: WebSocket error:"),
        ),
      ).toEqual([]);
    });
  }, 60_000);

  test("creates without a chat, discusses and edits work, removes comments with history, and restores layout", async () => {
    await withE2eFixture("tickets-human-workflow", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.selectWorkspaceWindowSurface("Open Tickets");
      await app.waitForText("No tickets yet");
      await app.clickButton("New ticket");
      await app.fill(
        '[role="dialog"] .ticket-title-input',
        "Synthetic human ticket",
      );
      await app.fill('[role="dialog"] input[list]', "Synthetic release");
      await app.clickDialogButton("Create ticket");
      await fixture.page.waitForSelector(".ticket-detail-title");
      await app.fill(
        'textarea[placeholder="Add to the discussion…"]',
        "Synthetic initial comment",
      );
      await app.clickButton("Comment");
      await fixture.page.waitForSelector("[data-comment-id]");
      await fixture.page.evaluate(() => {
        const edit = [
          ...document.querySelectorAll<HTMLButtonElement>(
            "[data-comment-id] button",
          ),
        ].find((button) => button.textContent?.trim() === "Edit");
        if (!edit) throw new Error("Missing author edit action");
        edit.click();
      });
      await app.fill("[data-comment-id] textarea", "Synthetic revised comment");
      await fixture.page.evaluate(() => {
        const form = document.querySelector<HTMLFormElement>(
          "[data-comment-id] form",
        );
        if (!form) throw new Error("Missing comment edit form");
        form.requestSubmit();
      });
      await app.waitForText("Synthetic revised comment");
      await fixture.page.evaluate(() => {
        const remove = [
          ...document.querySelectorAll<HTMLButtonElement>(
            "[data-comment-id] button",
          ),
        ].find((button) => button.textContent?.trim() === "Remove");
        if (!remove) throw new Error("Missing author remove action");
        remove.click();
      });
      await app.waitForText(
        "Previous versions, including removed text, remain in activity history.",
      );
      await fixture.page.evaluate(() => {
        const remove = [
          ...document.querySelectorAll<HTMLButtonElement>(
            "[data-comment-id] .ticket-notice button",
          ),
        ].find((button) => button.textContent?.trim() === "Remove");
        if (!remove) throw new Error("Missing removal confirmation");
        remove.click();
      });
      await app.waitForText("Comment removed");
      await app.clickButton("Activity");
      await app.waitForText("removed a comment");
      const history = parseTicketHistoryPage(
        await fixture.integration.client.get(
          "/api/v1/tickets/history?ticketId=G-1",
        ),
      );
      expect(
        history.items.filter((entry) => entry.action === "comment-edited"),
      ).toHaveLength(1);
      expect(
        history.items.find((entry) => entry.action === "comment-edited"),
      ).toMatchObject({
        before: "Synthetic initial comment",
        after: "Synthetic revised comment",
      });
      await app.clickButton("Edit");
      await app.fill(".ticket-detail input[list]", "Reassigned project");
      await app.clickButton("Save changes");
      await app.waitForText("Reassigned project");
      await app.clickButton("Back to tickets");
      await app.clickButton("Ticket view settings");
      await fixture.page.waitForSelector('[role="menuitemcheckbox"]');
      await fixture.page.evaluate(() => {
        const board = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]
          .find((item) => item.textContent?.trim() === 'Board');
        if (!board) throw new Error('Missing Board view option');
        board.click();
      });
      await fixture.page.waitForSelector(".ticket-board");
      await fixture.page.waitForFunction(() =>
        localStorage
          .getItem("workspace_layout_v2")
          ?.includes('"kind":"tickets"'),
      );
      const connections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: connections });
      await fixture.page.waitForSelector(".ticket-board");
      expect(
        parseTicketPage(await fixture.integration.client.get("/api/v1/tickets"))
          .items,
      ).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  }, 60_000);

  for (const restart of [false, true])
    test(`confirms a lost create without installing stale results (${restart ? "restart" : "missed invalidations"})`, async () => {
      await withE2eFixture(`tickets-retry-${restart}`, async (fixture) => {
        await fixture.page.evaluateOnNewDocument(() => {
          const nativeFetch = globalThis.fetch.bind(globalThis);
          let dropCreate = true;
          const NativeSocket = globalThis.WebSocket;
          globalThis.WebSocket = new Proxy(NativeSocket, {
            construct(Target, args: ConstructorParameters<typeof WebSocket>) {
              const socket = new Target(...args);
              socket.addEventListener("message", (event) => {
                try {
                  if (
                    JSON.parse(String(event.data)).type === "tickets-invalidated"
                  )
                    event.stopImmediatePropagation();
                } catch {
                  /* Other events remain untouched. */
                }
              });
              return socket;
            },
          });
          globalThis.fetch = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
              const response = await nativeFetch(...args);
              if (
                dropCreate &&
                String(args[0]).endsWith("/tickets/mutate") &&
                JSON.parse(String(args[1]?.body)).payload.action === "create"
              ) {
                dropCreate = false;
                await response.text();
                throw new TypeError("Synthetic lost ticket response");
              }
              return response;
            },
            { preconnect: globalThis.fetch.preconnect },
          );
        });
        const app = new SpaDriver(fixture.page, fixture.integration);
        await app.setViewport(1440, 900);
        await app.open();
        await fixture.waitForSpaWebSocket();
        await app.selectWorkspaceWindowSurface("Open Tickets");
        await app.waitForText("No tickets yet");
        await app.clickButton("New ticket");
        await app.fill(
          '[role="dialog"] .ticket-title-input',
          "Original synthetic title",
        );
        await app.fill('[role="dialog"] input[list]', "Synthetic release");
        await app.clickDialogButton("Create ticket");
        await app.waitForText("Save not confirmed.");
        const bootstrap = parseTicketBootstrap(
          await fixture.integration.client.get("/api/v1/tickets/bootstrap"),
        );
        const mutate = async (payload: TicketMutationPayload) =>
          parseTicketWriteResult(
            await fixture.integration.client.post("/api/v1/tickets/mutate", {
              requestId: crypto.randomUUID(),
              expectedStoreId: bootstrap.storeId,
              payload,
            }),
          );
        await mutate({
          action: "update",
          ticketId: "G-1",
          expectedRevision: 1,
          patch: { title: "Newer authoritative title" },
        });
        await mutate({
          action: "comment",
          ticketId: "G-1",
          body: "Newer authoritative comment",
        });
        let errorsAfterReconnect = 0;
        if (restart) {
          const connections = await fixture.spaWebSocketConnectionCount();
          fixture.assertNoBrowserErrors();
          await fixture.integration.crashAndRestartGarcon({ reusePort: true });
          await fixture.page.evaluate(() =>
            globalThis.dispatchEvent(new Event("online")),
          );
          await fixture.waitForSpaWebSocket({
            afterConnectionCount: connections,
          });
          errorsAfterReconnect = fixture.browserErrors.length;
          expect(
            fixture.browserErrors.filter(
              (message) =>
                !message.startsWith("console.error: WebSocket error:"),
            ),
          ).toEqual([]);
        }
        await app.clickDialogButton("Retry same request");
        await fixture.page.waitForFunction(
          () =>
            document.querySelector(".ticket-detail-title")?.textContent ===
            "Newer authoritative title",
        );
        await app.waitForText("Newer authoritative comment");
        const current = parseTicketDetail(
          await fixture.integration.client.get(
            "/api/v1/tickets/detail?ticketId=G-1",
          ),
        );
        expect(current.ticket.revision).toBe(2);
        expect(current.comments.items).toHaveLength(1);
        expect(
          parseTicketPage(await fixture.integration.client.get("/api/v1/tickets"))
            .items,
        ).toHaveLength(1);
        expect(
          await fixture.page.evaluate(() =>
            Object.keys(sessionStorage).filter((key) =>
              key.startsWith("garcon-ticket-draft-v1:"),
            ),
          ),
        ).toEqual([]);
        expect(fixture.browserErrors.slice(errorsAfterReconnect)).toEqual([]);
      });
    }, 60_000);
});
