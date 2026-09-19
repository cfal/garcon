import {
  type ProjectResolutionResponse,
  type ProjectTarget,
  type ProjectInspector,
} from '../../common/project-resolution.js';
import { parseChatId } from '../../common/chat-id.js';
import type { IChatRegistry } from '../chats/store.js';
import { DomainError, ValidationDomainError } from '../lib/domain-error.js';
import { jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { effectiveNodeId, parseNodeId } from '../../common/execution-nodes.js';

interface ProjectResolutionRouteDeps {
  registry: Pick<IChatRegistry, 'getChat'>;
  inspect: ProjectInspector;
}

export function createProjectResolutionRoutes(
  deps: ProjectResolutionRouteDeps,
): RouteMap {
  const inspect = deps.inspect;
  return {
    '/api/v1/projects/resolve': {
      GET: async (_request, url) => {
        try {
          const target = parseTarget(url);
          assertCurrentBinding(deps.registry, target);
          const resolution = await inspect(target.projectPath, target.nodeId);
          assertCurrentBinding(deps.registry, target);
          return noStore(Response.json({ target, resolution } satisfies ProjectResolutionResponse));
        } catch (error) {
          return noStore(jsonErrorFromUnknown(error));
        }
      },
    },
  };
}

function parseTarget(url: URL): ProjectTarget {
  const entries = [...url.searchParams.entries()].filter(([key]) => key !== 'nodeId');
  const nodeId = parseNodeId(url.searchParams.get('nodeId'));
  if (!nodeId || url.searchParams.getAll('nodeId').length > 1) throw new ValidationDomainError('Invalid execution node ID');
  const node = url.searchParams.has('nodeId') ? { nodeId } : {};
  const chatId = url.searchParams.get('chatId') ?? '';
  const expectedProjectPath = url.searchParams.get('expectedProjectPath') ?? '';
  const projectPath = url.searchParams.get('projectPath') ?? '';
  if (
    entries.length === 2
    && url.searchParams.getAll('chatId').length === 1
    && url.searchParams.getAll('expectedProjectPath').length === 1
    && chatId
    && expectedProjectPath.trim()
  ) {
    try {
      return { kind: 'chat', chatId: parseChatId(chatId), ...node, projectPath: expectedProjectPath };
    } catch {
      throw new ValidationDomainError('chatId must be a canonical Garcon chat ID');
    }
  }
  if (
    entries.length === 1
    && url.searchParams.getAll('projectPath').length === 1
    && projectPath.trim()
  ) {
    return { kind: 'path', ...node, projectPath };
  }
  throw new ValidationDomainError(
    'Provide either chatId with expectedProjectPath, or projectPath',
  );
}

function assertCurrentBinding(
  registry: Pick<IChatRegistry, 'getChat'>,
  target: ProjectTarget,
): void {
  if (target.kind !== 'chat') return;
  const chat = registry.getChat(target.chatId);
  if (!chat) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
  if (chat.projectPath !== target.projectPath || effectiveNodeId(chat.nodeId) !== effectiveNodeId(target.nodeId)) {
    throw new DomainError('PROJECT_PATH_CHANGED', 'The chat project changed', 409);
  }
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
