import crypto from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import type { AgentChatEntry, StartedAgentSession } from '../session-types.js';
import { createCursorStreamJsonNativePath, getCursorAgentSessionIdFromNativePath } from './cursor-native-path.js';
import {
  cursorStreamJsonSessionDirPath,
  cursorStreamJsonStoreDbPath,
} from './history-loader.js';

export interface CursorForkSessionOptions {
  cursorHome?: string;
  createSessionId?: () => string;
}

async function copyDirectoryEntries(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(targetPath);
      await copyDirectoryEntries(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported Cursor session store entry: ${sourcePath}`);
    }
    await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  }
}

async function copyCursorSessionDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir);
  try {
    await copyDirectoryEntries(sourceDir, targetDir);
  } catch (error) {
    await fs.rm(targetDir, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}

export async function forkCursorStreamJsonSession(
  sourceSession: Pick<AgentChatEntry, 'agentSessionId' | 'nativePath' | 'projectPath'>,
  options: CursorForkSessionOptions = {},
): Promise<StartedAgentSession> {
  const sourceSessionId = sourceSession.agentSessionId
    || getCursorAgentSessionIdFromNativePath(sourceSession.nativePath);
  if (!sourceSessionId) {
    throw new Error('Cursor source session id is required to fork.');
  }

  const targetSessionId = options.createSessionId?.() ?? crypto.randomUUID();
  const sourceDbPath = cursorStreamJsonStoreDbPath(sourceSessionId, sourceSession.projectPath, options.cursorHome);
  await fs.access(sourceDbPath, constants.F_OK);

  const sourceDir = cursorStreamJsonSessionDirPath(sourceSessionId, sourceSession.projectPath, options.cursorHome);
  const targetDir = cursorStreamJsonSessionDirPath(targetSessionId, sourceSession.projectPath, options.cursorHome);
  await copyCursorSessionDirectory(sourceDir, targetDir);

  return {
    agentSessionId: targetSessionId,
    nativePath: createCursorStreamJsonNativePath(targetSessionId),
  };
}
