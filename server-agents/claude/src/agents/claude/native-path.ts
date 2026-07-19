import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentLogger } from '@garcon/server-agent-interface';

const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const MAX_SANITIZED_LENGTH = 200;

export interface ClaudeNativePathOptions {
  configHomeDir?: string;
  logger?: AgentLogger;
}

export interface ClaudeNativePathSession {
  projectPath: string;
  agentSessionId?: string | null;
  nativePath?: string | null;
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function claudeConfigHomeDir(options: ClaudeNativePathOptions): string {
  return (
    options.configHomeDir
    ?? path.join(os.homedir(), '.claude')
  ).normalize('NFC');
}

function claudeProjectsDir(options: ClaudeNativePathOptions): string {
  return path.join(claudeConfigHomeDir(options), 'projects');
}

async function canonicalizeProjectPath(projectPath: string): Promise<string> {
  try {
    return (await fs.realpath(projectPath)).normalize('NFC');
  } catch {
    return projectPath.normalize('NFC');
  }
}

function transcriptFileName(agentSessionId: string): string {
  return `${agentSessionId}.jsonl`;
}

function configHomeDirFromNativePath(
  nativePath: string,
  agentSessionId: string,
): string | null {
  if (path.basename(nativePath) !== transcriptFileName(agentSessionId)) return null;
  const projectsDir = path.dirname(path.dirname(nativePath));
  if (path.basename(projectsDir) !== 'projects') return null;
  return path.dirname(projectsDir);
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export function sanitizeClaudeProjectPath(projectPath: string): string {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  const hash = typeof Bun !== 'undefined'
    ? Bun.hash(projectPath).toString(36)
    : simpleHash(projectPath);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}

export async function createClaudeNativePath(
  projectPath: string,
  agentSessionId: string,
  options: ClaudeNativePathOptions = {},
): Promise<string | null> {
  if (!projectPath || !agentSessionId) return null;
  const canonicalProjectPath = await canonicalizeProjectPath(projectPath);
  const projectDirectory = sanitizeClaudeProjectPath(canonicalProjectPath);
  if (!projectDirectory) return null;
  return path.join(
    claudeProjectsDir(options),
    projectDirectory,
    transcriptFileName(agentSessionId),
  );
}

async function searchClaudeProjects(
  agentSessionId: string,
  options: ClaudeNativePathOptions,
): Promise<string[]> {
  const projectsDir = claudeProjectsDir(options);
  let projectDirectories: string[];
  try {
    projectDirectories = await fs.readdir(projectsDir);
  } catch (error) {
    (options.logger ?? NOOP_LOGGER).warn('Claude transcript search directory is unavailable', {
      projectsDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const matches: string[] = [];
  const fileName = transcriptFileName(agentSessionId);
  for (const projectDirectory of projectDirectories.sort()) {
    const candidate = path.join(projectsDir, projectDirectory, fileName);
    if (await isFile(candidate)) matches.push(candidate);
  }
  return matches;
}

export async function resolveClaudeNativePath(
  session: ClaudeNativePathSession,
  options: ClaudeNativePathOptions = {},
): Promise<string | null> {
  const logger = options.logger ?? NOOP_LOGGER;
  const agentSessionId = session.agentSessionId;
  if (!agentSessionId) return null;

  if (session.nativePath && await isFile(session.nativePath)) {
    return session.nativePath;
  }

  const configHomeDirs = [
    ...(session.nativePath
      ? [configHomeDirFromNativePath(session.nativePath, agentSessionId)]
      : []),
    claudeConfigHomeDir(options),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const uniqueConfigHomeDirs = [...new Set(configHomeDirs)];

  for (const configHomeDir of uniqueConfigHomeDirs) {
    const derivedPath = await createClaudeNativePath(
      session.projectPath,
      agentSessionId,
      { configHomeDir },
    );
    if (derivedPath && await isFile(derivedPath)) {
      if (session.nativePath && session.nativePath !== derivedPath) {
        logger.warn('Claude stored transcript path is unavailable; using derived path', {
          agentSessionId,
          derivedPath,
        });
      }
      return derivedPath;
    }
  }

  const searchDirectories = uniqueConfigHomeDirs.map((configHomeDir) =>
    claudeProjectsDir({ configHomeDir })
  );
  logger.warn('Claude expected transcript path is unavailable; searching projects', {
    agentSessionId,
    searchDirectories,
  });
  const matches = [...new Set((await Promise.all(
    uniqueConfigHomeDirs.map((configHomeDir) =>
      searchClaudeProjects(agentSessionId, { configHomeDir, logger })
    ),
  )).flat())];
  if (matches.length === 1) {
    logger.warn('Claude transcript path recovered by session search', {
      agentSessionId,
      nativePath: matches[0]!,
    });
    return matches[0];
  }
  if (matches.length > 1) {
    logger.error('Claude transcript search found multiple files and refused to choose', {
      agentSessionId,
      matches,
    });
  }
  return null;
}
