import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentNativeEnvironment } from '@garcon/server-agent-interface';
import { loadAgentNativeEnvironment } from '../../agents/default-agent-integrations.js';
import { OWNED_ENVIRONMENT_KEYS, parseNodeExecutableSearchPath, pathsOverlap, type NodeInstanceConfiguration } from './configuration.js';

export interface NodeInstanceEnvironment {
  readonly homeDirectory: string;
  readonly values: Readonly<Record<string, string>>;
}

/** Constructs a complete child environment; the coordinator's credentials and native-home overrides are never inherited. */
export async function prepareNodeInstanceEnvironments(
  instances: readonly NodeInstanceConfiguration[], signal: AbortSignal, executableSearchPath: readonly string[],
  loadEnvironment: (agentId: string) => Promise<AgentNativeEnvironment> = loadAgentNativeEnvironment,
): Promise<ReadonlyMap<string, NodeInstanceEnvironment>> {
  const searchPath = parseNodeExecutableSearchPath(executableSearchPath);
  if (!searchPath) throw new TypeError('Invalid node executable search path');
  const environments = new Map<string, NodeInstanceEnvironment>();
  for (const instance of instances) {
    signal.throwIfAborted();
    const native = await loadEnvironment(instance.agentId);
    signal.throwIfAborted();
    const nativeDirectories = nativeEnvironmentDirectories(native, instance);
    await mkdir(instance.homeDirectory, { recursive: true, mode: 0o700 });
    const homeDirectory = await realpath(instance.homeDirectory);
    const stats = await lstat(homeDirectory);
    if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0
      || environments.has(instance.id) || [...environments.values()].some((prior) => pathsOverlap(prior.homeDirectory, homeDirectory))) {
      throw new Error('Instance native homes must be private, distinct directories owned by this user');
    }
    const directories = {
      XDG_CONFIG_HOME: path.join(homeDirectory, '.config'), XDG_CACHE_HOME: path.join(homeDirectory, '.cache'),
      XDG_DATA_HOME: path.join(homeDirectory, '.local', 'share'), XDG_STATE_HOME: path.join(homeDirectory, '.local', 'state'),
      XDG_RUNTIME_DIR: path.join(homeDirectory, '.run'), TMPDIR: path.join(homeDirectory, '.tmp'),
    };
    const nativeValues: Record<string, string> = {};
    for (const entry of nativeDirectories) {
      if (entry.environmentKey) nativeValues[entry.environmentKey] = path.resolve(homeDirectory, entry.path);
    }
    for (const directory of [...Object.values(directories), ...nativeDirectories.map((entry) => path.resolve(homeDirectory, entry.path))]) {
      if (directory === homeDirectory) continue;
      let parent = homeDirectory;
      for (const component of path.relative(homeDirectory, directory).split(path.sep)) {
        parent = path.join(parent, component);
        await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const metadata = await lstat(parent);
        if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.uid !== process.getuid?.()
          || (metadata.mode & 0o077) !== 0) throw new Error('Invalid instance private directory');
      }
    }
    signal.throwIfAborted();
    environments.set(instance.id, Object.freeze({ homeDirectory, values: Object.freeze({
      ...instance.environment, PATH: searchPath.join(path.delimiter), LANG: 'C.UTF-8',
      HOME: homeDirectory, ...directories, ...nativeValues, TMP: directories.TMPDIR, TEMP: directories.TMPDIR,
    }) }));
  }
  return environments;
}

function nativeEnvironmentDirectories(definition: AgentNativeEnvironment, instance: NodeInstanceConfiguration): AgentNativeEnvironment['directories'] {
  if (definition.integrationId !== instance.agentId || !Array.isArray(definition.directories) || definition.directories.length > 16) {
    throw new TypeError('Invalid provider native environment');
  }
  const keys = new Set<string>();
  return definition.directories.map(({ path: directory, environmentKey }) => {
    if (typeof directory !== 'string' || directory.length > 256
      || directory !== '.' && !directory.split('/').every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
      || environmentKey !== null && (!/^[A-Z_][A-Z0-9_]*$/.test(environmentKey) || keys.has(environmentKey)
        || OWNED_ENVIRONMENT_KEYS.has(environmentKey))) throw new TypeError('Invalid provider native environment');
    if (environmentKey !== null) {
      if (Object.hasOwn(instance.environment, environmentKey)) throw new TypeError('Native environment overrides are owned by the configured instance home');
      keys.add(environmentKey);
    }
    return { path: directory, environmentKey };
  });
}
