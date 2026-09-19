import { effectiveNodeId, parseNodeId, LOCAL_EXECUTION_NODE_ID } from '../../common/execution-nodes.js';
import { isRecord } from '../../common/json.js';
import type { IChatRegistry } from '../chats/store.js';
import { DomainError, ValidationDomainError } from '../lib/domain-error.js';
import { jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { MalformedJsonError, parseJsonBody } from '../lib/http-request.js';
import { malformedJsonResponse } from '../lib/json-route.js';

export function executionNodeIdFromUrl(url: URL, registry?: Pick<IChatRegistry, 'getChat'>): string {
  if (url.searchParams.getAll('nodeId').length > 1) throw new ValidationDomainError('Invalid execution node ID');
  const nodeId = parseNodeId(url.searchParams.get('nodeId'));
  if (!nodeId) throw new ValidationDomainError('Invalid execution node ID');
  const chatId = url.searchParams.get('chatId');
  if (!chatId || !registry) return nodeId;
  const chat = registry.getChat(chatId);
  if (!chat) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
  const current = effectiveNodeId(chat.nodeId);
  if (url.searchParams.has('nodeId') && current !== nodeId) {
    throw new DomainError('STALE_CHAT_OWNERSHIP', 'The chat execution node changed', 409);
  }
  return current;
}

export function executionNodeIdFromValue(value: unknown): string {
  const nodeId = parseNodeId(value);
  if (!nodeId) throw new ValidationDomainError('Invalid execution node ID');
  return nodeId;
}

export function localMachineRoutes(routes: RouteMap, registry: Pick<IChatRegistry, 'getChat'>): RouteMap {
  return Object.fromEntries(Object.entries(routes).map(([path, methods]) => [path,
    Object.fromEntries(Object.entries(methods).map(([method, handler]) => [method, async (request, url, server, context) => {
      try {
        assertLocalMachineNode(executionNodeIdFromUrl(url, registry));
        const body = await parseJsonBody(request.clone());
        if (isRecord(body)) {
          assertLocalMachineNode(executionNodeIdFromValue(body.nodeId));
          if (typeof body.chatId === 'string') {
            const chat = registry.getChat(body.chatId);
            if (!chat) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
            assertLocalMachineNode(effectiveNodeId(chat.nodeId));
          }
        }
        assertLocalMachineNode(executionNodeIdFromUrl(url, registry));
        return await handler(request, url, server, context);
      } catch (error) {
        return error instanceof MalformedJsonError ? malformedJsonResponse() : jsonErrorFromUnknown(error);
      }
    }])),
  ]));
}

export function assertLocalMachineNode(nodeId?: string | null): void {
  if (effectiveNodeId(nodeId) !== LOCAL_EXECUTION_NODE_ID) {
    throw new DomainError('OPERATION_UNSUPPORTED', 'Files, Git, and terminals are not available on remote execution nodes', 501);
  }
}
