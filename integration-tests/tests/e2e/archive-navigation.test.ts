import { describe, expect, test } from "bun:test";
import { withE2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

interface ArchiveRequestGate {
  requested: boolean;
  release?: () => void;
}

type ArchiveGateGlobal = typeof globalThis & {
  __garconArchiveRequestGate?: ArchiveRequestGate;
};

describe("Lightpanda archive navigation", () => {
  test("selects the recent-order neighbor before archiving and preserves a later selection", async () => {
    await withE2eFixture("archive-navigation", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();

      for (const prompt of [
        "already-archived",
        "later-selection",
        "manual-order-neighbor",
        "archive-source",
      ]) {
        await app.startOpenAiDirectChat(prompt);
        await app.waitForText(`echo:${prompt}`);
      }

      const chats = (await fixture.integration.client.listChats()).sessions;
      const byPrompt = (prompt: string) =>
        chats.find((chat) => chat.preview.firstMessage === prompt);
      const alreadyArchived = byPrompt("already-archived");
      const laterSelection = byPrompt("later-selection");
      const manualOrderNeighbor = byPrompt("manual-order-neighbor");
      const archiveSource = byPrompt("archive-source");
      if (
        !alreadyArchived ||
        !laterSelection ||
        !manualOrderNeighbor ||
        !archiveSource
      ) {
        throw new Error("Archive navigation chats were not listed.");
      }

      await fixture.integration.client.toggleArchive(alreadyArchived.id);
      await app.waitForSidebarChatIds("archived", [alreadyArchived.id]);

      await app.openChat(manualOrderNeighbor.id);
      await app.submitComposerWithEnter(
        "refresh-manual-order-neighbor-activity",
        "Send message",
      );
      await app.waitForText("echo:refresh-manual-order-neighbor-activity");
      await app.openChat(archiveSource.id);
      await app.setRecentActivitySort(true);
      await app.waitForSidebarChatIds("normal", [
        manualOrderNeighbor.id,
        archiveSource.id,
        laterSelection.id,
      ]);

      await fixture.page.evaluate(() => {
        const originalFetch = globalThis.fetch.bind(globalThis);
        const testGlobal = globalThis as ArchiveGateGlobal;
        const gate: ArchiveRequestGate = { requested: false };
        testGlobal.__garconArchiveRequestGate = gate;
        const gatedFetch = async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          let inputUrl: string;
          if (typeof input === "string") {
            inputUrl = input;
          } else if (input instanceof URL) {
            inputUrl = input.href;
          } else {
            inputUrl = input.url;
          }
          if (
            new URL(inputUrl, globalThis.location.href).pathname ===
            "/api/v1/chats/archive"
          ) {
            gate.requested = true;
            await new Promise<void>((resolve) => {
              gate.release = resolve;
            });
          }
          return originalFetch(input, init);
        };
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          writable: true,
          value: gatedFetch,
        });
      });

      await app.openSidebarChatActionsContaining("archive-source");
      await app.clickMenuItem("Archive");
      await fixture.page.waitForFunction(
        () =>
          (globalThis as ArchiveGateGlobal).__garconArchiveRequestGate
            ?.requested === true,
      );

      await app.waitForSelectedChat(laterSelection.id);
      await app.waitForSidebarChatIds("archived", [
        archiveSource.id,
        alreadyArchived.id,
      ]);
      const beforeRelease = await fixture.integration.client.listChats();
      expect(
        beforeRelease.sessions.find((chat) => chat.id === archiveSource.id)
          ?.isArchived,
      ).toBe(false);

      await app.clickSidebarChatById(manualOrderNeighbor.id);
      await app.waitForSelectedChat(manualOrderNeighbor.id);
      await fixture.page.evaluate(() => {
        const release = (globalThis as ArchiveGateGlobal)
          .__garconArchiveRequestGate?.release;
        if (!release) throw new Error("Archive request gate was not waiting.");
        release();
      });

      await app.openSidebarChatActionsContaining("archive-source");
      await app.waitForMenuItemEnabled("Unarchive");
      await app.waitForSidebarChatIds("archived", [
        archiveSource.id,
        alreadyArchived.id,
      ]);
      await app.waitForSelectedChat(manualOrderNeighbor.id);
      const afterRelease = await fixture.integration.client.listChats();
      expect(
        afterRelease.sessions.find((chat) => chat.id === archiveSource.id)
          ?.isArchived,
      ).toBe(true);
      fixture.assertNoBrowserErrors();
    });
  });
});
