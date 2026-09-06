// Resolves a project path from a request's `chatId` or `projectPath` query
// param, enforcing the project-base boundary. Shared by routes that operate
// against a project directory (files, slash-command discovery).

import type { ProjectUnavailableReason } from '../../common/project-resolution.js';
import { jsonError } from '../lib/http-error.js';
import { projectBoundaryErrorResponse } from '../lib/path-boundary.ts';
import type { IChatRegistry } from '../chats/store.js';
import { inspectProjectDirectory } from '../projects/project-directory-service.js';

export type ProjectPathResolution =
  | { projectPath: string; error?: undefined }
  | { error: Response; projectPath?: undefined };

export async function resolveAccessibleProjectPath(
  projectPath: string,
  inspect = inspectProjectDirectory,
): Promise<ProjectPathResolution> {
  const resolution = await inspect(projectPath);
  return resolution.kind === 'available'
    ? { projectPath: resolution.effectiveProjectKey }
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
): Promise<ProjectPathResolution> {
  const chatId = url.searchParams.get('chatId');
  if (chatId) {
    const chat = registry.getChat(chatId);
    if (!chat?.projectPath) {
      return {
        error: Response.json({ error: 'Chat not found or missing projectPath' }, { status: 404 }),
      };
    }
    return resolveAccessibleProjectPath(chat.projectPath);
  }

  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) {
    return { error: Response.json({ error: 'chatId or projectPath is required' }, { status: 400 }) };
  }
  return resolveAccessibleProjectPath(projectPath);
}
