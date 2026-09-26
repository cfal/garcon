import mime from 'mime-types';
import type { ExecutionFilesService, ExecutorCallOptions } from '@garcon/server-agent-interface';
import type { ProjectInspector } from '../../../common/project-resolution.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import { isRecord } from '../../../common/json.js';
import { FILE_REVISION_HEADER, parseSaveTextRequest, type ReadTextResponse } from '../../../common/file-contracts.js';
import type { IChatRegistry } from '../chats/store.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { withJsonBody } from '../lib/json-route.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { resolveProjectPathFromUrl } from './project-path-resolver.js';
import { executorIdFromUrl } from './executor-target.js';
import { createFileAttachmentRoutes } from './file-attachments.js';

interface FilesRouteDependencies {
  readonly files: (executorId: string) => Promise<ExecutionFilesService>;
  readonly inspectProject: ProjectInspector;
}

export default function createFilesRoutes(registry: IChatRegistry, dependencies: FilesRouteDependencies): RouteMap {
  const { files, inspectProject: inspect } = dependencies;

  async function project(url: URL, request: Request) {
    const chatId = url.searchParams.get('chatId');
    const captured = chatId ? registry.getChat(chatId) : null;
    const capturedPath = captured?.projectPath;
    const capturedExecutor = effectiveExecutorId(captured?.executorId);
    const resolved = await resolveProjectPathFromUrl(registry, url, inspect, { signal: request.signal });
    if (resolved.error) return resolved;
    const service = await files(resolved.executorId);
    if (chatId) {
      const current = registry.getChat(chatId);
      if (!current || current.projectPath !== capturedPath || effectiveExecutorId(current.executorId) !== capturedExecutor) {
        throw new DomainError('PROJECT_PATH_CHANGED', 'Project target changed during inspection', 409, true);
      }
    }
    return { service, projectPath: resolved.projectPath, executorId: resolved.executorId, error: undefined };
  }

  function filePath(url: URL): string {
    const value = url.searchParams.get('path');
    if (!value || value.length > 4096 || value.includes('\0')) throw new ValidationDomainError('Invalid file path');
    return value;
  }

  const callOptions = (request: Request): ExecutorCallOptions => ({ signal: request.signal, timeoutMs: 30_000 });
  function guarded(handler: RouteHandler): RouteHandler {
    return async (...args) => {
      try { return await handler(...args); }
      catch (error) {
        if (args[0].signal.aborted) return new Response(null, { status: 499 });
        return jsonErrorFromUnknown(error);
      }
    };
  }

  const read: RouteHandler = async (request, url) => {
    const resolved = await project(url, request);
    if (resolved.error) return resolved.error;
    const result = await resolved.service.read({ projectPath: resolved.projectPath, filePath: filePath(url) }, callOptions(request));
    if (url.pathname.endsWith('/text')) {
      const response: ReadTextResponse = { content: Buffer.from(result.bytes).toString('utf8'), path: result.path, revision: result.revision };
      return Response.json(response);
    }
    return new Response(Uint8Array.from(result.bytes), { headers: { 'Content-Type': mime.lookup(result.path) || 'application/octet-stream', [FILE_REVISION_HEADER]: result.revision } });
  };

  return {
    ...createFileAttachmentRoutes(),
    '/api/v1/files/tree': { GET: guarded(async (request, url) => {
      const service = await files(executorIdFromUrl(url, registry));
      try { return Response.json(await service.tree({ directoryPath: url.searchParams.get('path') || undefined }, callOptions(request))); }
      catch (error) {
        if (error instanceof DomainError) {
          const codes: Record<string, string> = { FILE_OUTSIDE_ROOT: 'outside_project_base', FILE_NOT_FOUND: 'FILE_TREE_DIRECTORY_NOT_FOUND', FILE_DIRECTORY_REQUIRED: 'FILE_TREE_DIRECTORY_REQUIRED', FILE_PERMISSION_DENIED: 'FILE_TREE_PERMISSION_DENIED' };
          return jsonError(error.message, error.status, codes[error.code] ?? error.code, error.retryable);
        }
        throw error;
      }
    }) },
    '/api/v1/files/browse': { GET: guarded(async (request, url) => {
      const service = await files(executorIdFromUrl(url, registry));
      return Response.json(await service.browse({ directoryPath: url.searchParams.get('path') || undefined }, callOptions(request)));
    }) },
    '/api/v1/files/list': { GET: guarded(async (request, url) => {
      const resolved = await project(url, request);
      if (resolved.error) return resolved.error;
      const result = await resolved.service.list({ projectPath: resolved.projectPath }, callOptions(request));
      return Response.json(result.files, { headers: result.truncated ? { 'X-Garcon-File-List-Truncated': 'true' } : undefined });
    }) },
    '/api/v1/files/identity': { GET: guarded(async (request, url) => {
      const resolved = await project(url, request);
      if (resolved.error) return resolved.error;
      const identity = await resolved.service.identity({ projectPath: resolved.projectPath, filePath: filePath(url) }, callOptions(request));
      return Response.json({ success: true, identity });
    }) },
    '/api/v1/files/revision': { GET: guarded(async (request, url) => {
      const resolved = await project(url, request);
      if (resolved.error) return resolved.error;
      return Response.json(await resolved.service.revision({ projectPath: resolved.projectPath, filePath: filePath(url) }, callOptions(request)));
    }) },
    '/api/v1/files/content': { GET: guarded(read) },
    '/api/v1/files/text': { GET: guarded(read), PUT: guarded(async (request, url, server, context) => {
      const boundUrl = new URL(url);
      boundUrl.searchParams.set('executorId', executorIdFromUrl(url, registry));
      const chatId = url.searchParams.get('chatId');
      const capturedPath = chatId ? registry.getChat(chatId)?.projectPath : null;
      return withJsonBody(async (body: unknown) => {
        if (isRecord(body) && ['executorId', 'chatId', 'projectPath', 'filePath'].some((key) => key in body)) {
          throw new ValidationDomainError('File targets must be supplied in the URL, not the request body');
        }
        const save = parseSaveTextRequest(body);
        if (!save) throw new ValidationDomainError('Content, expectedRevision, and conflictResolution are required');
        if (chatId && registry.getChat(chatId)?.projectPath !== capturedPath) throw new DomainError('PROJECT_PATH_CHANGED', 'Project target changed while reading the request', 409, true);
        const resolved = await project(boundUrl, request);
        if (resolved.error) return resolved.error;
        const result = await resolved.service.save({ ...save, projectPath: resolved.projectPath, filePath: filePath(boundUrl) }, callOptions(request));
        return Response.json(result);
      })(request, boundUrl, server, context);
    }) },
  };
}
