import type { ProjectUnavailableReason } from '../../common/project-resolution.js';
import { jsonError } from '../lib/http-error.js';
import { projectBoundaryErrorResponse } from '../lib/path-boundary.ts';
import type { IChatRegistry } from '../chats/store.js';

export type ProjectPathResolution =
  | { projectPath: string; error?: undefined }
  | { error: Response; projectPath?: undefined };

function projectPathNotFoundResponse(projectPath: string): Response {
  return Response.json(
    { error: `Project path not found: ${projectPath}` },
    { status: 404 },
  );
}

export function projectUnavailableResponse(projectPath: string, reason: ProjectUnavailableReason): Response {
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

// Selects the captured path; only the workspace service interprets it on its owner.
export function selectProjectPathFromUrl(
  registry: IChatRegistry,
  url: URL,
): ProjectPathResolution {
  const chatId = url.searchParams.get('chatId');
  if (chatId) {
    const chat = registry.getChat(chatId);
    if (!chat?.projectPath) {
      return {
        error: Response.json({ error: 'Chat not found or missing projectPath' }, { status: 404 }),
      };
    }
    return { projectPath: chat.projectPath };
  }

  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) {
    return { error: Response.json({ error: 'chatId or projectPath is required' }, { status: 400 }) };
  }
  return { projectPath };
}
