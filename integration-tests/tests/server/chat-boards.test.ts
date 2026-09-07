import { describe, expect, test } from "bun:test";
import type {
  ChatBoard,
  ChatBoardCatalog,
  ChatBoardMutationResponse,
  CreateChatBoardResponse,
} from "../../../common/chat-boards.js";
import type { ChatTagsMutationResponse } from "../../../common/chat-tag-mutations.js";
import type {
  ChatBoardsInvalidatedMessage,
  ChatListRefreshRequestedMessage,
} from "../../../common/ws-events.js";
import { GarconApiError } from "../../support/garcon-client.js";
import { withIntegrationFixture } from "../../support/integration-fixture.js";

const SOURCE_COLUMN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_COLUMN_ID = "22222222-2222-4222-8222-222222222222";

describe("Chat Board server integration", () => {
  test("persists ordered boards and transitions tags with typed invalidations", async () => {
    await withIntegrationFixture("chat-boards", async (fixture) => {
      const observer = await fixture.connectObserver("chat-board-observer");
      const initial = await fixture.client.get<ChatBoardCatalog>(
        "/api/v1/chat-boards",
      );
      expect(initial).toEqual({ revision: 0, boards: [] });

      const createdCursor = observer.markEvents();
      const delivery = await fixture.client.post<CreateChatBoardResponse>(
        "/api/v1/chat-boards",
        { expectedRevision: 0, name: "Delivery" },
      );
      expect(
        await observer.waitForEvent(
          (event): event is ChatBoardsInvalidatedMessage =>
            event.type === "chat-boards-invalidated" &&
            event.revision === delivery.catalog.revision &&
            event.reason === "created",
          "Chat Board creation invalidation",
          { afterIndex: createdCursor },
        ),
      ).toMatchObject({ revision: 1, reason: "created" });

      const secondary = await fixture.client.post<CreateChatBoardResponse>(
        "/api/v1/chat-boards",
        { expectedRevision: delivery.catalog.revision, name: "By owner" },
      );
      const reordered = await fixture.client.put<ChatBoardMutationResponse>(
        "/api/v1/chat-boards/order",
        {
          expectedRevision: secondary.catalog.revision,
          orderedBoardIds: [secondary.boardId, delivery.boardId],
        },
      );
      const deliveryBoard: ChatBoard = {
        id: delivery.boardId,
        name: "Delivery",
        columns: [
          {
            id: SOURCE_COLUMN_ID,
            name: "Ready",
            match: "all",
            tags: ["ready"],
          },
          {
            id: TARGET_COLUMN_ID,
            name: "Review",
            match: "any",
            tags: ["review", "verify"],
          },
        ],
      };
      const updated = await fixture.client.put<ChatBoardMutationResponse>(
        "/api/v1/chat-boards",
        { expectedRevision: reordered.catalog.revision, board: deliveryBoard },
      );

      try {
        await fixture.client.put("/api/v1/chat-boards", {
          expectedRevision: reordered.catalog.revision,
          board: { ...deliveryBoard, name: "Stale overwrite" },
        });
        throw new Error("Expected stale board update to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(GarconApiError);
        const conflict = error as GarconApiError;
        expect(conflict.status).toBe(409);
        expect(conflict.body).toMatchObject({
          errorCode: "CHAT_BOARD_REVISION_CONFLICT",
        });
      }

      const chatId = fixture.newChatId();
      const started = await fixture.client.startDirectChat({
        chatId,
        content: "Synthetic board integration prompt",
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      expect(
        await fixture.client.patch<ChatTagsMutationResponse>(
          "/api/v1/chats/tags/delta",
          { chatId, addTags: ["ready"] },
        ),
      ).toMatchObject({ tags: ["ready"], addedTags: ["ready"] });

      const tagCursor = observer.markEvents();
      const transitioned = await fixture.client.post<ChatTagsMutationResponse>(
        "/api/v1/chats/tag-transition",
        {
          chatId,
          boardId: delivery.boardId,
          sourceColumnId: SOURCE_COLUMN_ID,
          targetColumnId: TARGET_COLUMN_ID,
          expectedCatalogRevision: updated.catalog.revision,
          expectedTags: ["ready"],
          selectedTargetTags: ["review"],
        },
      );
      expect(transitioned).toMatchObject({
        tags: ["review"],
        addedTags: ["review"],
        removedTags: ["ready"],
      });
      await observer.waitForEvent(
        (event): event is ChatListRefreshRequestedMessage =>
          event.type === "chat-list-refresh-requested" &&
          event.reason === "tags-updated" &&
          event.chatId === chatId,
        "Chat Board tag refresh invalidation",
        { afterIndex: tagCursor },
      );
      expect(
        (await fixture.client.listChats()).sessions.find(
          (chat) => chat.id === chatId,
        )?.tags,
      ).toEqual(["review"]);

      await fixture.restartGarcon();
      const restored = await fixture.client.get<ChatBoardCatalog>(
        "/api/v1/chat-boards",
      );
      expect(restored.boards.map((board) => board.id)).toEqual([
        secondary.boardId,
        delivery.boardId,
      ]);
      expect(restored.boards[1]).toEqual(deliveryBoard);
      expect(
        (await fixture.client.listChats()).sessions.find(
          (chat) => chat.id === chatId,
        )?.tags,
      ).toEqual(["review"]);

      const removed = await fixture.client.delete<ChatBoardMutationResponse>(
        "/api/v1/chat-boards",
        { expectedRevision: restored.revision, boardId: delivery.boardId },
      );
      expect(removed.catalog.boards.map((board) => board.id)).toEqual([
        secondary.boardId,
      ]);
      expect(
        (await fixture.client.listChats()).sessions.find(
          (chat) => chat.id === chatId,
        )?.tags,
      ).toEqual(["review"]);
    });
  }, 60_000);
});
