import { MalformedJsonError, parseJsonBody } from './http-request.js';

export function malformedJsonResponse() {
  return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
}

export function withJsonBody(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('Route handler must be a function');
  }
  return async (request, url, server) => {
    let body;
    try {
      body = await parseJsonBody(request);
    } catch (error) {
      if (error instanceof MalformedJsonError) {
        return malformedJsonResponse();
      }
      throw error;
    }
    return handler(body, request, url, server);
  };
}
