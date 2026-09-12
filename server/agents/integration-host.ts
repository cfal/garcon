import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentEnvironmentReader,
  AgentHost,
  AgentHostFactory,
  AgentLegacyDirectoryClaim,
  AgentLogger,
  AgentScopedStorage,
} from '@garcon/server-agent-interface';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { JsonObject } from '@garcon/common/json';
import { isExecutionIdentity } from '../../common/execution-location.js';
import type { ConfiguredAgentInstance } from '../../common/execution-nodes.js';
import { createLogger } from '../lib/log.js';

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface IntegrationHostFactoryOptions {
  readonly workspaceDir: string;
  readonly instance?: Pick<ConfiguredAgentInstance, 'id' | 'agentId'>;
  readonly readEnvironment?: (name: string) => string | undefined;
  readonly loggerFactory?: (agentId: string) => AgentLogger;
}

class BoundEnvironmentReader implements AgentEnvironmentReader {
  readonly #read: (name: string) => string | undefined;
  #allowedNames: ReadonlySet<string> = new Set();
  #bound = false;

  constructor(read: (name: string) => string | undefined) {
    this.#read = read;
  }

  bind(names: readonly string[]): void {
    if (this.#bound) throw new Error('Agent environment is already bound');
    this.#allowedNames = new Set(names);
    this.#bound = true;
  }

  get(name: string): string | undefined {
    if (!this.#bound || !this.#allowedNames.has(name)) {
      throw new AgentIntegrationError(
        'INVALID_SETTINGS',
        `Agent attempted to read undeclared environment variable: ${name}`,
        false,
      );
    }
    return this.#read(name);
  }
}

class ScopedStorage implements AgentScopedStorage {
  readonly rootDirectory: string;
  readonly #workspaceDir: string;

  constructor(workspaceDir: string, private readonly namespace: readonly string[], private readonly legacyWorkspace: string | null) {
    this.#workspaceDir = path.resolve(workspaceDir);
    this.rootDirectory = path.join(this.#workspaceDir, 'agent-data', ...namespace);
  }

  async directory(namespace: string): Promise<string> {
    assertNamespace(namespace);
    await mkdir(this.#workspaceDir, { recursive: true });
    const dataDirectory = path.join(this.#workspaceDir, 'agent-data');
    if (this.legacyWorkspace) await mkdir(dataDirectory, { recursive: true });
    else await ensureDirectoryWithoutSymlink(dataDirectory);
    let parent = await realpath(dataDirectory);
    for (const component of this.namespace) {
      parent = path.join(parent, component);
      await ensureDirectoryWithoutSymlink(parent);
    }

    const root = await realpath(this.rootDirectory);
    const candidate = path.join(root, namespace);
    await ensureDirectoryWithoutSymlink(candidate);
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new AgentIntegrationError(
        'INVALID_SETTINGS',
        `Agent storage namespace escapes its scope: ${namespace}`,
        false,
      );
    }
    return resolved;
  }

  async claimLegacyWorkspaceDirectory(name: string): Promise<AgentLegacyDirectoryClaim> {
    assertNamespace(name);
    if (!this.legacyWorkspace) return { moved: 0, skipped: 0 };
    const source = path.join(this.legacyWorkspace, name);
    const sourceStats = await lstatOrNull(source);
    if (!sourceStats) return { moved: 0, skipped: 0 };
    assertDirectoryWithoutSymlink(source, sourceStats);

    const destination = await this.directory(name);
    const claim = { moved: 0, skipped: 0 };
    await moveDirectoryContents(source, destination, claim);
    return claim;
  }
}

async function ensureDirectoryWithoutSymlink(directory: string): Promise<void> {
  const existing = await lstatOrNull(directory);
  if (existing) {
    assertDirectoryWithoutSymlink(directory, existing);
    return;
  }
  await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  assertDirectoryWithoutSymlink(directory, await lstat(directory));
}

function assertDirectoryWithoutSymlink(
  directory: string,
  stats: Awaited<ReturnType<typeof lstat>>,
): void {
  if (stats.isSymbolicLink()) {
    throw new AgentIntegrationError(
      'INVALID_SETTINGS',
      `Agent storage path must not be a symbolic link: ${directory}`,
      false,
    );
  }
  if (!stats.isDirectory()) {
    throw new AgentIntegrationError(
      'INVALID_SETTINGS',
      `Agent storage path is not a directory: ${directory}`,
      false,
    );
  }
}

async function lstatOrNull(candidate: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function moveDirectoryContents(
  source: string,
  destination: string,
  claim: { moved: number; skipped: number },
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const sourceStats = await lstatOrNull(sourcePath);
    if (!sourceStats) continue;

    if (sourceStats.isSymbolicLink()) {
      claim.skipped += 1;
      continue;
    }
    if (sourceStats.isDirectory()) {
      await ensureDirectoryWithoutSymlink(destinationPath);
      await moveDirectoryContents(sourcePath, destinationPath, claim);
      continue;
    }
    if (!sourceStats.isFile()) {
      claim.skipped += 1;
      continue;
    }
    if (await lstatOrNull(destinationPath)) {
      claim.skipped += 1;
      continue;
    }
    await moveFile(sourcePath, destinationPath, claim);
  }
  await rmdir(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  });
}

async function moveFile(
  source: string,
  destination: string,
  claim: { moved: number; skipped: number },
): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') {
        claim.skipped += 1;
        return;
      }
      throw copyError;
    }
    await unlink(source);
  }
  claim.moved += 1;
}

function assertNamespace(namespace: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(namespace);
  } catch {
    decoded = '';
  }
  if (
    !NAMESPACE_PATTERN.test(namespace)
    || namespace === '.'
    || namespace === '..'
    || decoded !== namespace
    || path.isAbsolute(namespace)
    || namespace.includes('/')
    || namespace.includes('\\')
  ) {
    throw new AgentIntegrationError(
      'INVALID_SETTINGS',
      `Invalid agent storage namespace: ${namespace}`,
      false,
    );
  }
}

function defaultLogger(agentId: string): AgentLogger {
  const logger = createLogger(`agent-integration:${agentId}`);
  const write = (level: keyof AgentLogger, message: string, fields?: JsonObject): void => {
    logger[level](message, ...(fields ? [fields] : []));
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

interface HostRecord {
  readonly host: AgentHost;
  readonly environment: BoundEnvironmentReader;
}

export class IntegrationHostFactory implements AgentHostFactory {
  readonly #options: IntegrationHostFactoryOptions;
  readonly #hosts = new Map<string, HostRecord>();

  constructor(options: IntegrationHostFactoryOptions) {
    if (options.instance && (!isExecutionIdentity(options.instance.id) || !AGENT_ID_PATTERN.test(options.instance.agentId))) {
      throw new Error('Invalid agent instance storage identity');
    }
    this.#options = { ...options, ...(options.instance ? { instance: Object.freeze({ ...options.instance }) } : {}) };
  }

  forAgent(agentId: string): AgentHost {
    if (!AGENT_ID_PATTERN.test(agentId)) throw new Error(`Invalid agent integration ID: ${agentId}`);
    const instance = this.#options.instance;
    if (instance && instance.agentId !== agentId) throw new Error('Agent instance storage belongs to another provider');
    const existing = this.#hosts.get(agentId);
    if (existing) return existing.host;

    const environment = new BoundEnvironmentReader(
      this.#options.readEnvironment ?? ((name) => process.env[name]),
    );
    const host: AgentHost = Object.freeze({
      agentId,
      logger: this.#options.loggerFactory?.(agentId) ?? defaultLogger(agentId),
      storage: new ScopedStorage(this.#options.workspaceDir, instance ? ['instances', instance.id] : [agentId],
        instance ? null : path.resolve(this.#options.workspaceDir)),
      environment,
    });
    this.#hosts.set(agentId, { host, environment });
    return host;
  }

  bindConfiguration(agentId: string, environmentNames: readonly string[]): void {
    const record = this.#hosts.get(agentId);
    if (!record) throw new Error(`Agent host has not been constructed: ${agentId}`);
    record.environment.bind(environmentNames);
  }
}
