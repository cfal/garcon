import { isRecord } from '../../common/json.js';
import {
  isCanvasId, isCanvasRevision, parseCanvasContent,
  type CanvasContent, type DeleteCanvasResponse,
} from '../../common/chat-canvas.js';
import { CanvasError, type CanvasStore } from '../chat-canvas/store.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

async function respond(operation: () => Promise<unknown>, status = 200): Promise<Response> {
  try { return Response.json(await operation(), { status, headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) {
    if (error instanceof CanvasError) return jsonError(error.message, error.status, error.code);
    return jsonErrorFromUnknown(error);
  }
}

function content(value: unknown): CanvasContent {
  try { return parseCanvasContent(value); }
  catch { throw new CanvasError('CANVAS_INVALID', 'Invalid canvas content', 400); }
}

export function createCanvasRoutes(store: CanvasStore): RouteMap {
  return {
    '/api/v1/chat-canvases': {
      GET: (_request, url) => respond(() => {
        const id = url.searchParams.get('id');
        return id === null ? store.list() : store.get(id);
      }),
      POST: withJsonBody((body: unknown) => respond(() => {
        if (!isRecord(body) || !isCanvasId(body.id)) throw new CanvasError('CANVAS_INVALID', 'Canvas ID is required', 400);
        return store.create(body.id, content(body.content));
      }, 201)),
      PUT: withJsonBody((body: unknown) => respond(() => {
        if (!isRecord(body) || !isCanvasId(body.id) || !isCanvasRevision(body.expectedRevision)) {
          throw new CanvasError('CANVAS_INVALID', 'Canvas ID and revision are required', 400);
        }
        return store.update(body.id, body.expectedRevision, content(body.content));
      })),
      DELETE: withJsonBody((body: unknown) => respond(async (): Promise<DeleteCanvasResponse> => {
        if (!isRecord(body) || !isCanvasId(body.id) || !isCanvasRevision(body.expectedRevision)) {
          throw new CanvasError('CANVAS_INVALID', 'Canvas ID and revision are required', 400);
        }
        await store.remove(body.id, body.expectedRevision);
        return { success: true };
      })),
    },
  };
}
