import { MalformedJsonError, parseJsonBody } from './http-request.js';
import { jsonError } from './http-error.js';
import type { HttpRouteContext, RouteHandler } from './http-route-types.js';

type JsonBodyHandler<TBody> = (
  body: TBody,
  request: Request,
  url: URL,
  server?: unknown,
  context?: HttpRouteContext,
) => Response | Promise<Response>;

export function malformedJsonResponse(): Response {
  return jsonError('Malformed JSON', 400);
}

export function withJsonBody<TBody>(handler: JsonBodyHandler<TBody>): RouteHandler {
  if (typeof handler !== 'function') {
    throw new TypeError('Route handler must be a function');
  }
  return async (
    request: Request,
    url: URL,
    server?: unknown,
    context?: HttpRouteContext,
  ): Promise<Response> => {
    let body: unknown;
    try {
      body = await parseJsonBody(request);
    } catch (error) {
      if (error instanceof MalformedJsonError) {
        return malformedJsonResponse();
      }
      throw error;
    }
    return handler(body as TBody, request, url, server, context);
  };
}
