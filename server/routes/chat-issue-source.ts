import { issueSource, IssueValidationError } from '../../common/issue-validation.js';
import type { IChatRegistry } from '../chats/store.js';
import type { IssueSourceReader } from '../chats/chat-message-reader.js';
import { ValidationDomainError } from '../lib/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import { markRouteNoStore } from '../lib/http-route.js';
import type { RouteMap } from '../lib/http-route-types.js';

export function createChatIssueSourceRoutes(
  registry: Pick<IChatRegistry, 'hasChat'>,
  reader: IssueSourceReader,
): RouteMap {
  return {
    '/api/v1/chats/issue-source': { GET: markRouteNoStore(async (request, url) => {
      const response = await resolve(request, url);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }) },
  };

  async function resolve(request: Request, url: URL): Promise<Response> {
      try {
        const raw: Record<string, unknown> = {};
        for (const [key, value] of url.searchParams) {
          if (key in raw) throw new ValidationDomainError('Duplicate source field');
          raw[key] = key === 'ordinal' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
        }
        const source = issueSource(raw);
        request.signal.throwIfAborted();
        if (!registry.hasChat(source.chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
        const result = await reader.resolveIssueSource(source, request.signal);
        request.signal.throwIfAborted();
        if (!registry.hasChat(source.chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
        return Response.json(result);
      } catch (error) {
        if (request.signal.aborted) return new Response(null, { status: 499 });
        return jsonErrorFromUnknown(error instanceof IssueValidationError
          ? new ValidationDomainError(error.message) : error);
      }
  }
}
