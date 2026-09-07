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
  test("moves the row before the request and preserves a later manual selection", async () => {
    await withE2eFixture("archive-navigation", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();

      for (const prompt of [
        "already-archived",
        "manual-destination",
        "replacement",
        "archive-source",
      ]) {
        await app.startOpenAiDirectChat(prompt);
        await app.waitForText(`echo:${prompt}`);
      }

      const chats = (await fixture.integration.client.listChats()).sessions;
      const byPrompt = (prompt: string) =>
        chats.find((chat) => chat.preview.firstMessage === prompt);
      const alreadyArchived = byPrompt("already-archived");
      const manualDestination = byPrompt("manual-destination");
      const replacement = byPrompt("replacement");
      const archiveSource = byPrompt("archive-source");
      if (
        !alreadyArchived ||
        !manualDestination ||
        !replacement ||
        !archiveSource
      ) {
        throw new Error("Archive navigation chats were not listed.");
      }

      await fixture.integration.client.toggleArchive(alreadyArchived.id);
      await app.waitForSidebarChatIds("archived", [alreadyArchived.id]);

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

      await app.waitForSelectedChat(replacement.id);
      await app.waitForSidebarChatIds("archived", [
        archiveSource.id,
        alreadyArchived.id,
      ]);
      const beforeRelease = await fixture.integration.client.listChats();
      expect(
        beforeRelease.sessions.find((chat) => chat.id === archiveSource.id)
          ?.isArchived,
      ).toBe(false);

      await app.clickSidebarChatById(manualDestination.id);
      await app.waitForSelectedChat(manualDestination.id);
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
      await app.waitForSelectedChat(manualDestination.id);
      const afterRelease = await fixture.integration.client.listChats();
      expect(
        afterRelease.sessions.find((chat) => chat.id === archiveSource.id)
          ?.isArchived,
      ).toBe(true);
      fixture.assertNoBrowserErrors();
    });
  });
});
