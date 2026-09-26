import {
  type ProjectResolutionResponse,
  type ProjectTarget,
  type ProjectInspector,
} from '../../../common/project-resolution.js';
import { parseChatId } from '../../../common/chat-id.js';
import type { IChatRegistry } from '../chats/store.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { effectiveExecutorId, parseExecutorId } from '../../../common/executors.js';

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
      GET: async (request, url) => {
        try {
          const target = parseTarget(url);
          assertCurrentBinding(deps.registry, target);
          const resolution = await inspect(target.projectPath, target.executorId, { signal: request.signal });
          assertCurrentBinding(deps.registry, target);
          return noStore(Response.json({ target, resolution } satisfies ProjectResolutionResponse));
        } catch (error) {
          if (request.signal.aborted) return noStore(new Response(null, { status: 499 }));
          return noStore(jsonErrorFromUnknown(error));
        }
      },
    },
  };
}

function parseTarget(url: URL): ProjectTarget {
  const entries = [...url.searchParams.entries()].filter(([key]) => key !== 'executorId');
  const executorId = parseExecutorId(url.searchParams.get('executorId'));
  if (!executorId || url.searchParams.getAll('executorId').length > 1) throw new ValidationDomainError('Invalid executor ID');
  const executor = url.searchParams.has('executorId') ? { executorId } : {};
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
      return { kind: 'chat', chatId: parseChatId(chatId), ...executor, projectPath: expectedProjectPath };
    } catch {
      throw new ValidationDomainError('chatId must be a canonical Garcon chat ID');
    }
  }
  if (
    entries.length === 1
    && url.searchParams.getAll('projectPath').length === 1
    && projectPath.trim()
  ) {
    return { kind: 'path', ...executor, projectPath };
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
  if (chat.projectPath !== target.projectPath || effectiveExecutorId(chat.executorId) !== effectiveExecutorId(target.executorId)) {
    throw new DomainError('PROJECT_PATH_CHANGED', 'The chat project changed', 409);
  }
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
