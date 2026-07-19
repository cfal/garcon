import { promises as fs } from 'fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { isArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import type { PiConfig } from '../../config.js';
import {
  findPiSessionFileBySessionId,
  resolvePiConfiguredSessionDir,
} from './pi-session-paths.js';

export interface PiSessionReference {
  readonly agentSessionId?: string | null;
  readonly nativePath?: string | null;
  readonly projectPath: string;
}

export interface PiForkedSession {
  readonly agentSessionId: string;
  readonly nativePath: string;
}

async function existingNativePath(nativePath: string | null | undefined): Promise<string | null> {
  if (!nativePath || isArtificialNativePath(nativePath)) return null;
  try {
    await fs.access(nativePath);
    return nativePath;
  } catch {
    return null;
  }
}

export async function resolvePiForkSourcePath(
  sourceSession: PiSessionReference,
  config: PiConfig,
): Promise<string> {
  const storedNativePath = await existingNativePath(sourceSession.nativePath);
  if (storedNativePath) return storedNativePath;

  const agentSessionId = sourceSession.agentSessionId?.trim();
  if (!agentSessionId) {
    throw new Error('Cannot fork Pi session: missing agent session id.');
  }

  const resolvedPath = await findPiSessionFileBySessionId(
    agentSessionId,
    sourceSession.projectPath,
    config,
  );
  if (!resolvedPath) {
    throw new Error(`Cannot fork Pi session ${agentSessionId}: native session file was not found.`);
  }

  return resolvedPath;
}

export async function forkPiSession(
  sourceSession: PiSessionReference,
  config: PiConfig,
): Promise<PiForkedSession> {
  const sourcePath = await resolvePiForkSourcePath(sourceSession, config);
  const configuredSessionDir = resolvePiConfiguredSessionDir(sourceSession.projectPath, config);

  // Pi owns session graph metadata, so native forks must go through its session manager.
  const forked = SessionManager.forkFrom(sourcePath, sourceSession.projectPath, configuredSessionDir);
  const agentSessionId = forked.getSessionId();
  const nativePath = forked.getSessionFile() ?? null;

  if (!agentSessionId || !nativePath) {
    throw new Error('Pi fork did not create a persisted session file.');
  }

  return { agentSessionId, nativePath };
}
