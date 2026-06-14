import { promises as fs } from 'fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { isArtificialNativePath } from '../../chats/artificial-native-path.js';
import type { AgentChatEntry, StartedAgentSession } from '../session-types.js';
import {
  findPiSessionFileBySessionId,
  resolvePiConfiguredSessionDir,
} from './pi-session-paths.js';

async function existingNativePath(nativePath: string | null | undefined): Promise<string | null> {
  if (!nativePath || isArtificialNativePath(nativePath)) return null;
  try {
    await fs.access(nativePath);
    return nativePath;
  } catch {
    return null;
  }
}

export async function resolvePiForkSourcePath(sourceSession: AgentChatEntry): Promise<string> {
  const storedNativePath = await existingNativePath(sourceSession.nativePath);
  if (storedNativePath) return storedNativePath;

  const agentSessionId = sourceSession.agentSessionId?.trim();
  if (!agentSessionId) {
    throw new Error('Cannot fork Pi session: missing agent session id.');
  }

  const resolvedPath = await findPiSessionFileBySessionId(agentSessionId, sourceSession.projectPath);
  if (!resolvedPath) {
    throw new Error(`Cannot fork Pi session ${agentSessionId}: native session file was not found.`);
  }

  return resolvedPath;
}

export async function forkPiSession(sourceSession: AgentChatEntry): Promise<StartedAgentSession> {
  const sourcePath = await resolvePiForkSourcePath(sourceSession);
  const configuredSessionDir = resolvePiConfiguredSessionDir(sourceSession.projectPath);

  // Pi owns session graph metadata, so native forks must go through its session manager.
  const forked = SessionManager.forkFrom(sourcePath, sourceSession.projectPath, configuredSessionDir);
  const agentSessionId = forked.getSessionId();
  const nativePath = forked.getSessionFile() ?? null;

  if (!agentSessionId || !nativePath) {
    throw new Error('Pi fork did not create a persisted session file.');
  }

  return { agentSessionId, nativePath };
}
