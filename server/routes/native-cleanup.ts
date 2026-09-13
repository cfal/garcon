import { parseNativeCleanupRetryRequest } from '../../common/native-cleanup.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

export function createNativeCleanupRoutes(journal: Pick<AgentOwnershipJournal, 'nativeCleanupSnapshot' | 'retryNativeCleanup'>): RouteMap {
  return {
    '/api/v1/native-cleanup': {
      GET: () => Response.json(journal.nativeCleanupSnapshot()),
    },
    '/api/v1/native-cleanup/retry': {
      POST: withJsonBody(async (body: unknown) => {
        const request = parseNativeCleanupRetryRequest(body);
        if (!request) return jsonError('A chat ID and retained cleanup operation ID are required.', 400, 'VALIDATION_FAILED', false);
        try { return Response.json(await journal.retryNativeCleanup(request)); }
        catch (error) { return jsonErrorFromUnknown(error); }
      }),
    },
  };
}
