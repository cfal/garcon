import { constants, promises as fs } from 'fs';
import path from 'path';
import type { IChatRegistry } from '../../chats/store.js';
import { createLogger } from '../../lib/log.js';
import {
  cursorAcpStoreDbPath,
  cursorStreamJsonStoreDbPath,
} from './history-loader.js';
import {
  CURSOR_AGENT_ID,
  createCursorAcpNativePath,
  getCursorStreamJsonAgentSessionIdFromNativePath,
} from './cursor-native-path.js';

const logger = createLogger('cursor:acp-migration');
const SQLITE_SIDECAR_SUFFIXES = ['', '-wal', '-shm'];

export interface CursorAcpMigrationResult {
  converted: number;
  copied: number;
  skipped: number;
  failed: number;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function copySqliteStore(sourceDbPath: string, targetDbPath: string): Promise<boolean> {
  if (await pathExists(targetDbPath)) return false;
  if (!await pathExists(sourceDbPath)) return false;

  await fs.mkdir(path.dirname(targetDbPath), { recursive: true });
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sourcePath = `${sourceDbPath}${suffix}`;
    if (!await pathExists(sourcePath)) continue;
    await fs.copyFile(sourcePath, `${targetDbPath}${suffix}`);
  }
  return true;
}

export async function migrateCursorStreamJsonSessionsToAcp(
  registry: Pick<IChatRegistry, 'getRegistry' | 'saveRegistry'>,
  cursorHome?: string,
): Promise<CursorAcpMigrationResult> {
  const snapshot = registry.getRegistry();
  let dirty = false;
  const result: CursorAcpMigrationResult = {
    converted: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
  };

  for (const [chatId, session] of Object.entries(snapshot.sessions)) {
    if (session.agentId !== CURSOR_AGENT_ID) continue;

    const agentSessionId = getCursorStreamJsonAgentSessionIdFromNativePath(session.nativePath);
    if (!agentSessionId) continue;

    const acpNativePath = createCursorAcpNativePath(agentSessionId);
    if (!acpNativePath) {
      result.skipped += 1;
      continue;
    }

    const sourceDbPath = cursorStreamJsonStoreDbPath(agentSessionId, session.projectPath, cursorHome);
    const targetDbPath = cursorAcpStoreDbPath(agentSessionId, cursorHome);
    try {
      if (await copySqliteStore(sourceDbPath, targetDbPath)) {
        result.copied += 1;
      }
    } catch (error) {
      result.failed += 1;
      logger.warn(`chat ${chatId}: failed to copy stream-json transcript DB for Cursor session ${agentSessionId}:`, (error as Error).message);
      continue;
    }

    session.agentSessionId = session.agentSessionId || agentSessionId;
    session.nativePath = acpNativePath;
    result.converted += 1;
    dirty = true;
  }

  if (dirty) {
    await registry.saveRegistry(snapshot);
    logger.info(`converted ${result.converted} Cursor stream-json session(s) to ACP native paths`);
  }

  return result;
}
