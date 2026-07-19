import path from 'path';
import { promises as fs } from 'fs';
import {
  getAgentDir,
  SessionManager,
  SettingsManager,
  type SessionHeader,
} from '@earendil-works/pi-coding-agent';
import type { PiConfig } from '../../config.js';

function expandTilde(value: string, config: PiConfig): string {
  if (value === '~') return config.homeDirectory();
  if (value.startsWith('~/')) return path.join(config.homeDirectory(), value.slice(2));
  return value;
}

export function resolvePiConfiguredSessionDir(
  projectPath: string,
  config: PiConfig,
): string | undefined {
  const sessionDirOverride = config.sessionDirectoryOverride();
  if (sessionDirOverride) return expandTilde(sessionDirOverride, config);

  try {
    const settings = SettingsManager.create(projectPath, getAgentDir());
    return settings.getSessionDir();
  } catch {
    return undefined;
  }
}

function encodePiCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function fileTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, '-');
}

export function piDefaultSessionDir(projectPath: string): string {
  return path.join(getAgentDir(), 'sessions', encodePiCwd(projectPath));
}

export function piSessionPathFromHeader(header: SessionHeader, sessionDir?: string): string {
  const fileName = `${fileTimestamp(header.timestamp)}_${header.id}.jsonl`;
  return path.join(sessionDir ?? piDefaultSessionDir(header.cwd), fileName);
}

export async function findPiSessionFileBySessionId(
  sessionId: string,
  projectPath: string,
  config: PiConfig,
): Promise<string | null> {
  if (!sessionId || !projectPath) return null;
  const configuredSessionDir = resolvePiConfiguredSessionDir(projectPath, config);

  try {
    const localSessions = await SessionManager.list(projectPath, configuredSessionDir);
    const localMatch = localSessions.find((session) => session.id === sessionId);
    if (localMatch) {
      await fs.access(localMatch.path);
      return localMatch.path;
    }
  } catch {
    return null;
  }

  if (configuredSessionDir) return null;

  try {
    const allSessions = await SessionManager.listAll();
    const globalMatch = allSessions.find((session) => session.id === sessionId);
    if (!globalMatch) return null;
    await fs.access(globalMatch.path);
    return globalMatch.path;
  } catch {
    return null;
  }
}
