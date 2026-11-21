import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '@garcon/common/json';
import { hasNodeErrorCode } from '@garcon/server-agent-common/lib/errors';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import type { PiConfig } from '../../config.js';

// Pi accepts MSYS, WSL, and Cygwin drive spellings but leaves UNC paths intact.
export function nativePiWindowsPath(value: string): string {
  if (value.includes('\\')) return value;
  const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
  return drive ? `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? '').replaceAll('/', '\\')}` : value;
}

function resolvePiPath(value: string, cwd: string, home: string): string {
  if (process.platform === 'win32') value = nativePiWindowsPath(value);
  if (value === '~') value = home;
  else if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    value = path.join(home, value.slice(2));
  } else if (value.startsWith('file://')) value = fileURLToPath(value);
  return path.resolve(cwd, value);
}

function samePiPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function sessionDirSetting(settingsFile: string): Promise<string | undefined> {
  let settings: unknown;
  try {
    const raw = await readFile(settingsFile, 'utf8');
    settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    // Pi ignores a missing or invalid settings file without discarding the other scope.
    return undefined;
  }
  if (!isRecord(settings) || settings.sessionDir === undefined) return undefined;
  if (settings.sessionDir === null) return '';
  if (typeof settings.sessionDir !== 'string') {
    throw new Error('Invalid Pi session directory settings.');
  }
  return settings.sessionDir;
}

export async function canonicalExistingPiSessionPath(value: string): Promise<string | null> {
  if (!path.isAbsolute(value)) return null;
  try {
    return (await stat(value)).isFile() ? path.normalize(await realpath(value)) : null;
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

// Pi selects the session directory before resolving project trust or loading extensions.
// https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/main.ts#L735-L744
export async function findPiSessionFileBySessionId(
  sessionId: string,
  projectPath: string,
  config: PiConfig,
): Promise<string | null> {
  if (!sessionId || !projectPath) return null;
  const home = config.homeDirectory();
  const projectDir = resolvePiPath(projectPath, process.cwd(), home);
  const agentDir = resolvePiPath(config.agentDirectoryOverride() ?? path.join(home, '.pi', 'agent'), projectDir, home);
  const configured = config.sessionDirectoryOverride()
    ?? await sessionDirSetting(path.join(projectDir, '.pi', 'settings.json'))
    ?? await sessionDirSetting(path.join(agentDir, 'settings.json'));
  const sessionsRoot = path.join(agentDir, 'sessions');
  const local = `--${projectDir.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const localDir = path.join(sessionsRoot, local);
  if (configured) {
    const directory = resolvePiPath(configured, projectDir, home);
    if (samePiPath(directory, localDir)) return findInDirectory(directory, sessionId);
    return findInDirectory(directory, sessionId, (cwd) => {
      if (typeof cwd !== 'string' || !cwd) return false;
      return samePiPath(resolvePiPath(cwd, process.cwd(), home), projectDir);
    });
  }
  const nearby = await findInDirectory(localDir, sessionId);
  if (nearby) return nearby;
  let match: string | null = null;
  for await (const entry of directoryEntries(sessionsRoot)) {
    if (!entry.isDirectory() || entry.name === local) continue;
    const candidate = await findInDirectory(path.join(sessionsRoot, entry.name), sessionId);
    if (!candidate) continue;
    if (match) throw new Error('Pi transcript discovery found duplicate session IDs');
    match = candidate;
  }
  return match;
}

async function* directoryEntries(directory: string) {
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  yield* handle;
}

async function findInDirectory(
  directory: string,
  sessionId: string,
  matchesProject: (cwd: unknown) => boolean = () => true,
): Promise<string | null> {
  let match: string | null = null;
  for await (const entry of directoryEntries(directory)) {
    if (!entry.name.endsWith('.jsonl')) continue;
    const nativeName = /^\d{4}-\d\d-\d\dT[\d-]+Z_(.+)\.jsonl$/.exec(entry.name);
    if (nativeName && nativeName[1] !== sessionId) continue;
    const named = entry.name.endsWith(`_${sessionId}.jsonl`);
    if (!entry.isFile()) {
      if (named) throw new Error('Pi transcript source is not a regular file');
      continue;
    }
    // Standard filenames contain their immutable ID. Renamed files need only their header.
    const candidate = path.join(directory, entry.name);
    let header: unknown;
    try {
      for await (const { line } of readJsonlLineEntries(candidate, { maxLineBytes: 1024 * 1024 })) {
        header = JSON.parse(line);
        break;
      }
    } catch (error) {
      if (named) throw new Error('Pi transcript header could not be read', { cause: error });
      continue;
    }
    if (!isRecord(header) || header.type !== 'session' || header.id !== sessionId) {
      if (named) throw new Error('Pi transcript header does not match the selected session');
      continue;
    }
    if (!matchesProject(header.cwd)) continue;
    if (match) throw new Error('Pi transcript discovery found duplicate session files');
    match = candidate;
  }
  return match;
}
