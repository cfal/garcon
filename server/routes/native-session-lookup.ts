import {
  NativeSessionLookupValidationError,
  parseNativeSessionLookupRequest,
  type NativeSessionLookupRequest,
  type NativeSessionLookupResponse,
} from '../../common/native-session-lookup.js';
import type { IChatRegistry } from '../chats/store.js';
import { jsonError } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

interface NativeSessionLookupAgents {
  hasAgent(agentId: string): boolean;
}

export function createNativeSessionLookupRoutes(
  registry: Pick<IChatRegistry, 'lookupNativeSession'>,
  agents: NativeSessionLookupAgents,
): RouteMap {
  function postLookupNativeSession(body: unknown): Response {
    let input: NativeSessionLookupRequest;
    try {
      input = parseNativeSessionLookupRequest(body);
    } catch (error) {
      if (error instanceof NativeSessionLookupValidationError) {
        return jsonError(error.message, 400, 'VALIDATION_FAILED', false);
      }
      throw error;
    }

    if (input.agent !== undefined && !agents.hasAgent(input.agent)) {
      return jsonError(`Unsupported agent: ${input.agent}`, 422, 'UNSUPPORTED_AGENT', false);
    }

    const result = registry.lookupNativeSession(input.nativeSessionId, input.agent);
    if (result.status === 'not-found') {
      return jsonError(
        'No chat matches the native session ID',
        404,
        'NATIVE_SESSION_NOT_FOUND',
        false,
      );
    }
    if (result.status === 'ambiguous') {
      return jsonError(
        'Multiple chats match the native session ID',
        409,
        'NATIVE_SESSION_AMBIGUOUS',
        false,
      );
    }
    const response: NativeSessionLookupResponse = { chatId: result.chatId };
    return Response.json(response);
  }

  return {
    '/api/v1/chats/lookup-native-session': {
      POST: withJsonBody(postLookupNativeSession),
    },
  };
}
