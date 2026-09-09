import type {
  ApplyChatTagDeltaRequest,
  ReplaceChatTagsRequest,
  TransitionChatTagsRequest,
} from '../../common/chat-tag-mutations.js';
import { isChatBoardId } from '../../common/chat-boards.js';
import { normalizeTags } from '../../common/tags.js';
import { ChatBoardDomainError } from '../chat-boards/errors.js';
import type { ChatTagMutationService } from '../chats/chat-tag-mutation-service.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

function recordWithOnlyKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key)) ? record : null;
}

function chatId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function tags(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((tag) => typeof tag === 'string')
    ? normalizeTags(value)
    : null;
}

function errorResponse(error: unknown): Response {
  if (!(error instanceof ChatBoardDomainError)) return jsonErrorFromUnknown(error);
  const payload: Record<string, unknown> = {
    success: false,
    error: error.message,
    errorCode: error.code,
    retryable: error.retryable,
  };
  if (error.currentTags) payload.currentTags = error.currentTags;
  if (error.catalog) payload.catalog = error.catalog;
  if (error.code === 'CHAT_TAG_SAVE_UNKNOWN') payload.recoveryRequired = true;
  return Response.json(payload, { status: error.status });
}

function validationError(message: string): Response {
  return jsonError(message, 400, 'CHAT_TAG_VALIDATION_FAILED', false);
}

export function createChatTagRoutes(chatTags: ChatTagMutationService): RouteMap {
  return {
    '/api/v1/chats/tags': {
      GET: async (_request, url) => {
        const id = chatId(url.searchParams.get('chatId'));
        if (!id || [...url.searchParams.keys()].some((key) => key !== 'chatId')) {
          return validationError('chatId is required');
        }
        try {
          return Response.json(await chatTags.recover(id));
        } catch (error) {
          return errorResponse(error);
        }
      },
      PATCH: withJsonBody(async (value: unknown) => {
        const body = recordWithOnlyKeys(value, ['chatId', 'expectedTags', 'tags']);
        const id = chatId(body?.chatId);
        const expected = tags(body?.expectedTags);
        const next = tags(body?.tags);
        if (!id || !expected || !next) {
          return validationError('chatId, expectedTags, and tags are required');
        }
        try {
          return Response.json(await chatTags.replace({
            chatId: id,
            expectedTags: expected,
            tags: next,
          } satisfies ReplaceChatTagsRequest));
        } catch (error) {
          return errorResponse(error);
        }
      }),
    },
    '/api/v1/chats/tags/delta': {
      PATCH: withJsonBody(async (value: unknown) => {
        const body = recordWithOnlyKeys(value, ['chatId', 'addTags', 'removeTags']);
        const id = chatId(body?.chatId);
        const addTags = body?.addTags === undefined ? undefined : tags(body.addTags);
        const removeTags = body?.removeTags === undefined ? undefined : tags(body.removeTags);
        if (
          !id
          || addTags === null
          || removeTags === null
          || (!addTags?.length && !removeTags?.length)
        ) return validationError('chatId and at least one tag change are required');
        try {
          return Response.json(await chatTags.applyDelta({
            chatId: id,
            ...(addTags ? { addTags } : {}),
            ...(removeTags ? { removeTags } : {}),
          } satisfies ApplyChatTagDeltaRequest));
        } catch (error) {
          return errorResponse(error);
        }
      }),
    },
    '/api/v1/chats/tag-transition': {
      POST: withJsonBody(async (value: unknown) => {
        const body = recordWithOnlyKeys(value, [
          'chatId',
          'boardId',
          'sourceColumnId',
          'targetColumnId',
          'expectedCatalogRevision',
          'expectedTags',
          'selectedTargetTags',
        ]);
        const id = chatId(body?.chatId);
        const revision = body?.expectedCatalogRevision;
        const expected = tags(body?.expectedTags);
        const selected = body?.selectedTargetTags === undefined
          ? undefined
          : tags(body.selectedTargetTags);
        if (
          !id
          || !isChatBoardId(body?.boardId)
          || !isChatBoardId(body?.sourceColumnId)
          || !isChatBoardId(body?.targetColumnId)
          || typeof revision !== 'number'
          || !Number.isSafeInteger(revision)
          || revision < 0
          || !expected
          || selected === null
        ) return validationError('The chat transition request is invalid');
        try {
          return Response.json(await chatTags.transition({
            chatId: id,
            boardId: body.boardId,
            sourceColumnId: body.sourceColumnId,
            targetColumnId: body.targetColumnId,
            expectedCatalogRevision: revision,
            expectedTags: expected,
            ...(selected ? { selectedTargetTags: selected } : {}),
          } satisfies TransitionChatTagsRequest));
        } catch (error) {
          return errorResponse(error);
        }
      }),
    },
  };
}
