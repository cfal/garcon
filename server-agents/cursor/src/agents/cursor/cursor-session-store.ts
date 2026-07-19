import crypto from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import type { AgentChatEntry, StartedAgentSession } from '@garcon/server-agent-common/legacy/session-types';
import { createCursorAcpNativePath, getCursorAgentSessionIdFromNativePath } from './cursor-native-path.js';
import {
  cursorAcpSessionDirPath,
  cursorAcpStoreDbPath,
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function copySqliteStore(sourceDbPath: string, targetDbPath: string): Promise<void> {
  if (!await pathExists(sourceDbPath)) {
    throw new Error(`Cursor source session database not found: ${sourceDbPath}`);
  }
  await fs.mkdir(path.dirname(targetDbPath), { recursive: true });
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const sourcePath = `${sourceDbPath}${suffix}`;
      if (!await pathExists(sourcePath)) continue;
      await fs.copyFile(sourcePath, `${targetDbPath}${suffix}`, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    await fs.rm(path.dirname(targetDbPath), { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}

export async function forkCursorAcpSession(
  sourceSession: Pick<AgentChatEntry, 'agentSessionId' | 'nativePath' | 'projectPath'>,
  options: CursorForkSessionOptions = {},
): Promise<StartedAgentSession> {
  const sourceSessionId = sourceSession.agentSessionId
    || getCursorAgentSessionIdFromNativePath(sourceSession.nativePath);
  if (!sourceSessionId) {
    throw new Error('Cursor source session id is required to fork.');
  }

  const targetSessionId = options.createSessionId?.() ?? crypto.randomUUID();
  const sourceAcpDir = cursorAcpSessionDirPath(sourceSessionId, options.cursorHome);
  const targetAcpDir = cursorAcpSessionDirPath(targetSessionId, options.cursorHome);

  if (await pathExists(cursorAcpStoreDbPath(sourceSessionId, options.cursorHome))) {
    await copyCursorSessionDirectory(sourceAcpDir, targetAcpDir);
  } else {
    const sourceStreamJsonDbPath = cursorStreamJsonStoreDbPath(
      sourceSessionId,
      sourceSession.projectPath,
      options.cursorHome,
    );
    await copySqliteStore(sourceStreamJsonDbPath, cursorAcpStoreDbPath(targetSessionId, options.cursorHome));
  }

  return {
    agentSessionId: targetSessionId,
    nativePath: createCursorAcpNativePath(targetSessionId),
  };
}
