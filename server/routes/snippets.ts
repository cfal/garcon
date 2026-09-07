import type {
  CreateSnippetRequest,
  ExpandSnippetRequest,
  RemoveSnippetRequest,
  SnippetsMutationResponse,
  UpdateSnippetRequest,
} from '../../common/snippets.js';
import { SnippetDomainError } from '../snippets/errors.js';
import type { SnippetService } from '../snippets/service.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('routes:snippets');

function expectedRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function snippetError(error: unknown): Response {
  if (error instanceof SnippetDomainError) {
    return jsonError(error.message, error.status, error.code, error.retryable);
  }
  logger.error('Unexpected snippets request failure:', error);
  return jsonErrorFromUnknown(error);
}

export default function createSnippetRoutes(
  snippets: SnippetService,
): RouteMap {
  function getSnippets(): Response {
    return Response.json(snippets.snapshot());
  }

  async function postSnippet(body: CreateSnippetRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    if (revision === null || !body?.snippet) {
      return jsonError(
        'expectedRevision and snippet are required',
        400,
        'SNIPPET_VALIDATION_FAILED',
      );
    }
    try {
      const snapshot = await snippets.create({
        expectedRevision: revision,
        snippet: body.snippet,
      });
      return Response.json(
        { success: true, snapshot } satisfies SnippetsMutationResponse,
        { status: 201 },
      );
    } catch (error) {
      return snippetError(error);
    }
  }

  async function putSnippet(body: UpdateSnippetRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    if (revision === null || typeof body?.id !== 'string' || !body?.snippet) {
      return jsonError(
        'expectedRevision, id, and snippet are required',
        400,
        'SNIPPET_VALIDATION_FAILED',
      );
    }
    try {
      const snapshot = await snippets.update({
        expectedRevision: revision,
        id: body.id,
        snippet: body.snippet,
      });
      return Response.json({
        success: true,
        snapshot,
      } satisfies SnippetsMutationResponse);
    } catch (error) {
      return snippetError(error);
    }
  }

  async function deleteSnippet(body: RemoveSnippetRequest): Promise<Response> {
    const revision = expectedRevision(body?.expectedRevision);
    if (revision === null || typeof body?.id !== 'string') {
      return jsonError(
        'expectedRevision and id are required',
        400,
        'SNIPPET_VALIDATION_FAILED',
      );
    }
    try {
      const snapshot = await snippets.remove({
        expectedRevision: revision,
        id: body.id,
      });
      return Response.json({
        success: true,
        snapshot,
      } satisfies SnippetsMutationResponse);
    } catch (error) {
      return snippetError(error);
    }
  }

  async function postExpand(body: ExpandSnippetRequest): Promise<Response> {
    try {
      return Response.json(await snippets.expand(body));
    } catch (error) {
      return snippetError(error);
    }
  }

  return {
    '/api/v1/snippets': {
      GET: getSnippets,
      POST: withJsonBody(postSnippet),
      PUT: withJsonBody(putSnippet),
      DELETE: withJsonBody(deleteSnippet),
    },
    '/api/v1/snippets/expand': { POST: withJsonBody(postExpand) },
  };
}
