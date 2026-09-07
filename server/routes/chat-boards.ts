import {
  isChatBoardId,
  normalizeChatBoard,
  type CreateChatBoardRequest,
  type DeleteChatBoardRequest,
  type ReorderChatBoardsRequest,
  type UpdateChatBoardRequest,
} from '../../common/chat-boards.js';
import { ChatBoardDomainError } from '../chat-boards/errors.js';
import type { ChatBoardService } from '../chat-boards/service.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

function recordWithOnlyKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key)) ? record : null;
}

function expectedRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function errorResponse(error: unknown): Response {
  if (!(error instanceof ChatBoardDomainError)) return jsonErrorFromUnknown(error);
  const payload: Record<string, unknown> = {
    success: false,
    error: error.message,
    errorCode: error.code,
    retryable: error.retryable,
  };
  if (error.catalog) payload.catalog = error.catalog;
  return Response.json(payload, { status: error.status });
}

function validationError(message: string): Response {
  return jsonError(message, 400, 'CHAT_BOARD_VALIDATION_FAILED', false);
}

export function createChatBoardRoutes(chatBoards: ChatBoardService): RouteMap {
  return {
    '/api/v1/chat-boards': {
      GET: async () => Response.json(chatBoards.snapshot()),
      POST: withJsonBody(async (value: unknown) => {
        const body = recordWithOnlyKeys(value, ['expectedRevision', 'name']);
        const revision = expectedRevision(body?.expectedRevision);
        if (revision === null || typeof body?.name !== 'string') {
          return validationError('expectedRevision and name are required');
        }
        try {
          const result = await chatBoards.create({
            expectedRevision: revision,
            name: body.name,
          } satisfies CreateChatBoardRequest);
          return Response.json({ success: true, boardId: result.boardId, catalog: result.catalog }, {
            status: 201,
          });
        } catch (error) {
          return errorResponse(error);
        }
      }),
      PUT: withJsonBody(async (value: unknown) => {
        const body = recordWithOnlyKeys(value, ['expectedRevision', 'board']);
        const revision = expectedRevision(body?.expectedRevision);
        const board = normalizeChatBoard(body?.board);
        if (revision === null || !board) {
          return validationError('expectedRevision and a valid board are required');
        }
        try {
          const catalog = await chatBoards.update({
            expectedRevision: revision,
            board,
          } satisfies UpdateChatBoardRequest);
          return Response.json({ success: true, catalog });
        } catch (error) {
          return errorResponse(error);
        }
      }),
      DELETE: withJsonBody(async (value: unknown) => {
        const body = recordWithOnlyKeys(value, ['expectedRevision', 'boardId']);
        const revision = expectedRevision(body?.expectedRevision);
        if (revision === null || !isChatBoardId(body?.boardId)) {
          return validationError('expectedRevision and boardId are required');
        }
        try {
          const catalog = await chatBoards.remove({
            expectedRevision: revision,
            boardId: body.boardId,
          } satisfies DeleteChatBoardRequest);
          return Response.json({ success: true, catalog });
        } catch (error) {
          return errorResponse(error);
        }
      }),
    },
    '/api/v1/chat-boards/order': {
      PUT: withJsonBody(async (value: unknown) => {
        const body = recordWithOnlyKeys(value, ['expectedRevision', 'orderedBoardIds']);
        const revision = expectedRevision(body?.expectedRevision);
        const orderedBoardIds = Array.isArray(body?.orderedBoardIds)
          && body.orderedBoardIds.every(isChatBoardId)
          ? body.orderedBoardIds
          : null;
        if (revision === null || !orderedBoardIds) {
          return validationError('expectedRevision and orderedBoardIds are required');
        }
        try {
          const catalog = await chatBoards.reorder({
            expectedRevision: revision,
            orderedBoardIds,
          } satisfies ReorderChatBoardsRequest);
          return Response.json({ success: true, catalog });
        } catch (error) {
          return errorResponse(error);
        }
      }),
    },
  };
}
