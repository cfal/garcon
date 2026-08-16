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

function resolvePiConfiguredSessionDirStrict(
  projectPath: string,
  config: PiConfig,
): string | undefined {
  const sessionDirOverride = config.sessionDirectoryOverride();
  if (sessionDirOverride) return expandTilde(sessionDirOverride, config);
  const settings = SettingsManager.create(projectPath, getAgentDir());
  return settings.getSessionDir();
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

export async function canonicalExistingPiSessionPath(value: string): Promise<string | null> {
  if (!path.isAbsolute(value)) return null;
  try {
    if (!(await fs.stat(value)).isFile()) return null;
    return path.normalize(await fs.realpath(value));
  } catch {
    return null;
  }
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

export async function findPiSessionFileBySessionIdStrict(
  sessionId: string,
  projectPath: string,
  config: PiConfig,
): Promise<string | null> {
  if (!sessionId || !projectPath) return null;
  const configuredSessionDir = resolvePiConfiguredSessionDirStrict(projectPath, config);
  const localDirectory = configuredSessionDir ?? piDefaultSessionDir(projectPath);
  const localMatch = await findPiSessionFileInDirectory(localDirectory, sessionId);
  if (localMatch || configuredSessionDir) return localMatch;

  const sessionsRoot = path.join(getAgentDir(), 'sessions');
  const projectDirectories = await readPiDirectoryEntries(sessionsRoot);
  let globalMatch: string | null = null;
  for (const entry of projectDirectories) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = await findPiSessionFileInDirectory(
      path.join(sessionsRoot, entry.name),
      sessionId,
    );
    if (!candidate) continue;
    if (globalMatch) throw new Error('Pi transcript discovery found duplicate session IDs');
    globalMatch = candidate;
  }
  return globalMatch;
}

async function findPiSessionFileInDirectory(
  directory: string,
  sessionId: string,
): Promise<string | null> {
  const suffix = `_${sessionId}.jsonl`;
  const matches = (await readPiDirectoryEntries(directory))
    .filter((entry) => entry.name.endsWith(suffix));
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error('Pi transcript discovery found duplicate session files');
  const match = matches[0]!;
  if (!match.isFile() || match.isSymbolicLink()) {
    throw new Error('Pi transcript source is not a regular file');
  }
  return path.join(directory, match.name);
}

async function readPiDirectoryEntries(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
