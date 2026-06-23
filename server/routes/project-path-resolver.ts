// Resolves a project path from a request's `chatId` or `projectPath` query
// param, enforcing the project-base boundary. Shared by routes that operate
// against a project directory (files, slash-command discovery).

import { promises as fs } from 'fs';
import {
  assertRealWithinProjectBase,
  isProjectBoundaryError,
  projectBoundaryErrorResponse,
} from '../lib/path-boundary.ts';
import type { IChatRegistry } from '../chats/store.js';

export type ProjectPathResolution =
  | { projectPath: string; error?: undefined }
  | { error: Response; projectPath?: undefined };

export async function resolveAccessibleProjectPath(
  projectPath: string,
): Promise<ProjectPathResolution> {
  let resolvedProjectPath = projectPath;
  try {
    resolvedProjectPath = await assertRealWithinProjectBase(projectPath);
  } catch (error) {
    if (isProjectBoundaryError(error)) return { error: projectBoundaryErrorResponse() };
    throw error;
  }

  try {
    await fs.access(resolvedProjectPath);
    return { projectPath: resolvedProjectPath };
  } catch {
    return {
      error: Response.json(
        { error: `Project path not found: ${resolvedProjectPath}` },
        { status: 404 },
      ),
    };
  }
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
