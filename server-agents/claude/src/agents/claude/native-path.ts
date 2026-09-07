import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  AgentIntegrationError,
  type AgentLogger,
} from '@garcon/server-agent-interface';

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

export interface ClaudeNativeSessionRelocation {
  readonly nativePath: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
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

function isSafeSessionPathSegment(agentSessionId: string): boolean {
  return (
    agentSessionId.length > 0
    && agentSessionId !== '.'
    && agentSessionId !== '..'
    && path.basename(agentSessionId) === agentSessionId
  );
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
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${simpleHash(projectPath)}`;
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

interface ClaudeSessionArtifacts {
  readonly transcriptPath: string;
  readonly queuePath: string;
  readonly supportPath: string;
}

function sessionArtifacts(
  transcriptPath: string,
  agentSessionId: string,
): ClaudeSessionArtifacts {
  const projectDirectory = path.dirname(transcriptPath);
  return {
    transcriptPath,
    queuePath: path.join(projectDirectory, `${agentSessionId}.queue.json`),
    supportPath: path.join(projectDirectory, agentSessionId),
  };
}

async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    return (await fs.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function removeClaudeSessionArtifacts(
  artifacts: ClaudeSessionArtifacts,
): Promise<void> {
  await Promise.all([
    fs.rm(artifacts.transcriptPath, { force: true }),
    fs.rm(artifacts.queuePath, { force: true }),
    fs.rm(artifacts.supportPath, { recursive: true, force: true }),
  ]);
}

function relocationError(
  logger: AgentLogger,
  operation: string,
  error: unknown,
): AgentIntegrationError {
  logger.error('Claude session artifact relocation failed', {
    operation,
    error: error instanceof Error ? error.message : String(error),
  });
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    'Claude session transcript could not be preserved for project-path update',
    false,
  );
}

export async function prepareClaudeNativeSessionRelocation(input: {
  readonly previousProjectPath: string;
  readonly nextProjectPath: string;
  readonly agentSessionId: string;
  readonly nativePath: string | null;
  readonly configHomeDir?: string;
  readonly logger?: AgentLogger;
}): Promise<ClaudeNativeSessionRelocation> {
  const logger = input.logger ?? NOOP_LOGGER;
  if (!isSafeSessionPathSegment(input.agentSessionId)) {
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Claude session transcript is outside the expected project-state directory',
      false,
    );
  }
  const sourcePath = await resolveClaudeNativePath({
    projectPath: input.previousProjectPath,
    agentSessionId: input.agentSessionId,
    nativePath: input.nativePath,
  }, {
    configHomeDir: input.configHomeDir,
    logger,
  });
  if (!sourcePath) {
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Claude session transcript could not be resolved for project-path update',
      false,
    );
  }
  if (!configHomeDirFromNativePath(sourcePath, input.agentSessionId)) {
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Claude session transcript is outside the expected project-state directory',
      false,
    );
  }

  const targetPath = await createClaudeNativePath(
    input.nextProjectPath,
    input.agentSessionId,
    { configHomeDir: input.configHomeDir, logger },
  );
  if (!targetPath) {
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Claude session destination could not be resolved',
      false,
    );
  }
  if (sourcePath === targetPath) {
    return {
      nativePath: targetPath,
      async commit() {},
      async rollback() {},
    };
  }

  const source = sessionArtifacts(sourcePath, input.agentSessionId);
  const target = sessionArtifacts(targetPath, input.agentSessionId);
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await removeClaudeSessionArtifacts(target);
    await fs.copyFile(source.transcriptPath, target.transcriptPath);
    if (await isFile(source.queuePath)) {
      await fs.copyFile(source.queuePath, target.queuePath);
    }
    if (await isDirectory(source.supportPath)) {
      await fs.cp(source.supportPath, target.supportPath, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
      });
    }
  } catch (error) {
    await removeClaudeSessionArtifacts(target).catch((cleanupError) => {
      logger.warn('Claude session relocation rollback failed', {
        operation: 'prepare',
        error: cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
      });
    });
    throw relocationError(logger, 'prepare', error);
  }

  return {
    nativePath: targetPath,
    async commit() {
      try {
        await removeClaudeSessionArtifacts(source);
      } catch (error) {
        throw relocationError(logger, 'commit', error);
      }
    },
    async rollback() {
      try {
        await removeClaudeSessionArtifacts(target);
      } catch (error) {
        throw relocationError(logger, 'rollback', error);
      }
    },
  };
}
