import {
  isPreambleId,
  type CreatePreambleRequest,
  type RemovePreambleRequest,
  type ReorderPreamblesRequest,
  type UpdatePreambleRequest,
} from '../../common/preambles.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { PreambleDomainError } from '../preambles/errors.js';
import type { PreambleService } from '../preambles/service.js';

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function revision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function responseForError(error: unknown): Response {
  return error instanceof PreambleDomainError
    ? jsonError(error.message, error.status, error.code, error.retryable)
    : jsonErrorFromUnknown(error);
}

export default function createPreambleRoutes(preambles: PreambleService): RouteMap {
  return {
    '/api/v1/preambles': {
      GET: async () => Response.json(preambles.snapshot()),
      POST: withJsonBody(async (body: CreatePreambleRequest) => {
        if (!hasOnlyKeys(body, ['expectedRevision', 'preamble'])) {
          return jsonError('expectedRevision and preamble are required', 400, 'PREAMBLE_VALIDATION_FAILED');
        }
        const expectedRevision = revision(body?.expectedRevision);
        if (expectedRevision === null || !body?.preamble) {
          return jsonError('expectedRevision and preamble are required', 400, 'PREAMBLE_VALIDATION_FAILED');
        }
        try {
          const snapshot = await preambles.create({ expectedRevision, preamble: body.preamble });
          return Response.json({ success: true, snapshot }, { status: 201 });
        } catch (error) {
          return responseForError(error);
        }
      }),
      PUT: withJsonBody(async (body: UpdatePreambleRequest) => {
        if (!hasOnlyKeys(body, ['expectedRevision', 'id', 'preamble'])) {
          return jsonError('expectedRevision, id, and preamble are required', 400, 'PREAMBLE_VALIDATION_FAILED');
        }
        const expectedRevision = revision(body?.expectedRevision);
        const id = typeof body?.id === 'string' ? body.id : '';
        if (expectedRevision === null || !isPreambleId(id) || !body?.preamble) {
          return jsonError('expectedRevision, id, and preamble are required', 400, 'PREAMBLE_VALIDATION_FAILED');
        }
        try {
          const snapshot = await preambles.update({ expectedRevision, id, preamble: body.preamble });
          return Response.json({ success: true, snapshot });
        } catch (error) {
          return responseForError(error);
        }
      }),
      DELETE: withJsonBody(async (body: RemovePreambleRequest) => {
        if (!hasOnlyKeys(body, ['expectedRevision', 'id'])) {
          return jsonError('expectedRevision and id are required', 400, 'PREAMBLE_VALIDATION_FAILED');
        }
        const expectedRevision = revision(body?.expectedRevision);
        const id = typeof body?.id === 'string' ? body.id : '';
        if (expectedRevision === null || !isPreambleId(id)) {
          return jsonError('expectedRevision and id are required', 400, 'PREAMBLE_VALIDATION_FAILED');
        }
        try {
          const snapshot = await preambles.remove({ expectedRevision, id });
          return Response.json({ success: true, snapshot });
        } catch (error) {
          return responseForError(error);
        }
      }),
    },
    '/api/v1/preambles/reorder': {
      PUT: withJsonBody(async (body: ReorderPreamblesRequest) => {
        if (!hasOnlyKeys(body, ['expectedRevision', 'orderedPreambleIds'])) {
          return jsonError('expectedRevision and orderedPreambleIds are required', 400, 'PREAMBLE_VALIDATION_FAILED');
        }
        const expectedRevision = revision(body?.expectedRevision);
        const orderedPreambleIds = Array.isArray(body?.orderedPreambleIds)
          ? body.orderedPreambleIds.filter((id): id is string => isPreambleId(id))
          : null;
        if (
          expectedRevision === null
          || !orderedPreambleIds
          || orderedPreambleIds.length !== body.orderedPreambleIds.length
        ) return jsonError('expectedRevision and orderedPreambleIds are required', 400, 'PREAMBLE_VALIDATION_FAILED');
        try {
          const snapshot = await preambles.reorder({ expectedRevision, orderedPreambleIds });
          return Response.json({ success: true, snapshot });
        } catch (error) {
          return responseForError(error);
        }
      }),
    },
  };
}
