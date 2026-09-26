// Resolves a project path from a request's `chatId` or `projectPath` query
// param, enforcing the project-base boundary. Shared by routes that operate
// against a project directory (files, slash-command discovery).

import type { ProjectInspector, ProjectUnavailableReason } from '../../../common/project-resolution.js';
import { jsonError } from '../../common/http-error.js';
import { projectBoundaryErrorResponse } from '../lib/path-boundary.ts';
import type { IChatRegistry } from '../chats/store.js';
import { executorIdFromUrl } from './executor-target.js';
import { effectiveExecutorId } from '../../../common/executors.js';

export type ProjectPathResolution =
  | { projectPath: string; executorId: string; error?: undefined }
  | { error: Response; projectPath?: undefined };

export async function resolveAccessibleProjectPath(
  projectPath: string,
  inspect: ProjectInspector,
  executorId?: string | null,
  options?: { readonly signal?: AbortSignal },
): Promise<ProjectPathResolution> {
  const resolution = await inspect(projectPath, executorId, options);
  return resolution.kind === 'available'
    ? { projectPath: resolution.effectiveProjectKey, executorId: effectiveExecutorId(executorId) }
    : { error: unavailableResponse(projectPath, resolution.reason) };
}

function projectPathNotFoundResponse(projectPath: string): Response {
  return Response.json(
    { error: `Project path not found: ${projectPath}` },
    { status: 404 },
  );
}

function unavailableResponse(projectPath: string, reason: ProjectUnavailableReason): Response {
  if (reason === 'not-found') return projectPathNotFoundResponse(projectPath);
  if (reason === 'outside-base') return projectBoundaryErrorResponse();
  if (reason === 'not-a-directory') {
    return jsonError(
      `Project path is not a directory: ${projectPath}`,
      400,
      'PROJECT_PATH_NOT_DIRECTORY',
      false,
    );
  }
  return jsonError(
    `Project folder cannot be accessed: ${projectPath}`,
    403,
    'VALIDATION_FAILED',
    false,
  );
}

// Resolves the project path from either a chatId or projectPath query param.
export async function resolveProjectPathFromUrl(
  registry: IChatRegistry,
  url: URL,
  inspect: ProjectInspector,
  options?: { readonly signal?: AbortSignal },
): Promise<ProjectPathResolution> {
  const executorId = executorIdFromUrl(url, registry);
  const chatId = url.searchParams.get('chatId');
  if (chatId) {
    const chat = registry.getChat(chatId);
    if (!chat?.projectPath) {
      return {
        error: Response.json({ error: 'Chat not found or missing projectPath' }, { status: 404 }),
      };
    }
    const projectPath = chat.projectPath;
    const resolved = await resolveAccessibleProjectPath(projectPath, inspect, executorId, options);
    const current = registry.getChat(chatId);
    if (!current || current.projectPath !== projectPath || effectiveExecutorId(current.executorId) !== executorId) {
      return { error: jsonError('Project target changed during inspection', 409, 'PROJECT_PATH_CHANGED', true) };
    }
    return resolved;
  }

  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) {
    return { error: Response.json({ error: 'chatId or projectPath is required' }, { status: 400 }) };
  }
  return resolveAccessibleProjectPath(projectPath, inspect, executorId, options);
}
