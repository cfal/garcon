import { InvalidChatIdError, parseChatId } from '../../common/chat-id.js';
import { CommandRequestValidationError } from '../../common/command-request-validation.js';
import {
  CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES,
  parsePreambleSelectionPreviewRequest,
  parseUpdateChatPreambleSelectionRequest,
  type PreambleSelectionPreviewResponse,
  type UpdateChatPreambleSelectionRequest,
  type UpdateChatPreambleSelectionResponse,
} from '../../common/chat-preamble-selection-contracts.js';
import {
  defaultOrderedPreambleIds,
  projectPreambleSelection,
} from '../preambles/selection.js';
import type { ChatPreambleSelectionService } from '../preambles/chat-selection-service.js';
import { ChatPreambleSelectionPartialError } from '../preambles/chat-selection-service.js';
import { PreambleProjectPathService } from '../preambles/project-path-service.js';
import type { PreambleService } from '../preambles/service.js';
import { MalformedJsonError } from '../lib/http-request.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { ValidationDomainError } from '../lib/domain-error.js';

export function createChatPreambleRoutes(deps: {
  readonly selection: ChatPreambleSelectionService;
  readonly preambles: Pick<PreambleService, 'snapshot'>;
  // Injectable for tests; defaults to the shared canonical-path authority.
  readonly projectPaths?: Pick<PreambleProjectPathService, 'resolve'>;
}): RouteMap {
  const projectPaths = deps.projectPaths ?? new PreambleProjectPathService();
  return {
    '/api/v1/chats/preambles': {
      GET: async (request: Request, url: URL): Promise<Response> => {
        try {
          const rawChatId = url.searchParams.get('chatId');
          if (!rawChatId) throw new ValidationDomainError('chatId query parameter is required');
          const target = await deps.selection.target(
            parseChatId(rawChatId),
            request.signal,
          );
          return noStore(Response.json(target));
        } catch (error) {
          return noStore(jsonErrorFromUnknown(normalizeRouteError(error)));
        }
      },
      PUT: async (request: Request): Promise<Response> => {
        let body: unknown;
        try {
          body = await parseLimitedJsonBody(request);
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            return noStore(jsonError(
              `Request body exceeds ${CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES} bytes`,
              413,
            ));
          }
          if (error instanceof MalformedJsonError) {
            return noStore(jsonError('Malformed JSON', 400));
          }
          return noStore(jsonErrorFromUnknown(error));
        }
        let input: UpdateChatPreambleSelectionRequest;
        try {
          input = parseUpdateChatPreambleSelectionRequest(body);
        } catch (error) {
          return noStore(jsonErrorFromUnknown(normalizeRouteError(error)));
        }
        try {
          const outcome = await deps.selection.update(input);
          const response: UpdateChatPreambleSelectionResponse = {
            success: true,
            commandType: 'chat-preambles-update',
            clientRequestId: input.clientRequestId,
            clientMessageId: input.clientMessageId,
            chatId: input.chatId,
            transcriptViewId: input.transcriptViewId,
            status: outcome.status,
            mutationRevision: outcome.mutationRevision,
            noticeOrdinal: outcome.noticeOrdinal,
            selection: outcome.selection,
            projection: outcome.projection,
          };
          return noStore(Response.json(response));
        } catch (error) {
          if (error instanceof ChatPreambleSelectionPartialError) {
            return noStore(Response.json({
              success: false,
              errorCode: error.code,
              message: error.message,
              retryable: false,
              selectionCommitted: error.selectionCommitted,
              ...(error.selection === null ? {} : { selection: error.selection }),
            }, { status: 503 }));
          }
          return noStore(jsonErrorFromUnknown(normalizeRouteError(error)));
        }
      },
    },
    '/api/v1/preambles/selection-preview': {
      POST: async (request: Request): Promise<Response> => {
        let body: unknown;
        try {
          body = await parseLimitedJsonBody(request);
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            return noStore(jsonError(
              `Request body exceeds ${CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES} bytes`,
              413,
            ));
          }
          if (error instanceof MalformedJsonError) {
            return noStore(jsonError('Malformed JSON', 400));
          }
          return noStore(jsonErrorFromUnknown(error));
        }
        let parsed;
        try {
          parsed = parsePreambleSelectionPreviewRequest(body);
        } catch (error) {
          return noStore(jsonErrorFromUnknown(normalizeRouteError(error)));
        }
        try {
          const canonicalProjectPath = await projectPaths.resolve(parsed.projectPath);
          const catalog = deps.preambles.snapshot();
          const orderedPreambleIds = parsed.orderedPreambleIds === undefined
            ? defaultOrderedPreambleIds(catalog, canonicalProjectPath)
            : [...parsed.orderedPreambleIds];
          const response: PreambleSelectionPreviewResponse = {
            success: true,
            canonicalProjectPath,
            orderedPreambleIds,
            projection: projectPreambleSelection(
              { revision: 0, orderedPreambleIds },
              catalog,
              canonicalProjectPath,
            ),
          };
          return noStore(Response.json(response));
        } catch (error) {
          return noStore(jsonErrorFromUnknown(error));
        }
      },
    },
  };
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the size limit');
    this.name = 'BodyTooLargeError';
  }
}

// Reads the body as UTF-8 bytes with a hard cap; `text.length` would count
// code units, not bytes, so multibyte chunked bodies could bypass the limit.
async function parseLimitedJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES) {
    throw new BodyTooLargeError();
  }
  if (!request.body) {
    const text = await request.text();
    if (text.length > CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES) throw new BodyTooLargeError();
    return text ? JSON.parse(text) : {};
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Fatal decoding: replacement characters must not launder malformed byte
  // sequences into a valid request body.
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text ? JSON.parse(text) : {};
  } catch {
    throw new MalformedJsonError();
  }
}

function normalizeRouteError(error: unknown): unknown {
  if (error instanceof CommandRequestValidationError || error instanceof InvalidChatIdError) {
    return new ValidationDomainError(error.message);
  }
  return error;
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
