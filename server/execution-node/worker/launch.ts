import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { serverSelfCommand } from '../../lib/self-command.js';
import { nodeWorkerRoleFlag, type NodeWorkerRole } from './roles.js';

export const NODE_WORKER_BUN_OPTIONS = '--config=/dev/null';

export function nodeWorkerCommand(role: NodeWorkerRole): [string, ...string[]] {
  const command = serverSelfCommand([nodeWorkerRoleFlag(role)]);
  return Reflect.get(globalThis, Symbol.for('garcon.compiled-mode')) === true
    ? command : [command[0], '--no-env-file', '--config=/dev/null', ...command.slice(1)];
}

export async function prepareNodeStorageDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory);
  await assertPrivateDirectory(canonical);
  return canonical;
}

export async function prepareNodeInstanceStorage(directory: string, instanceId: string): Promise<string> {
  if (!isExecutionIdentity(instanceId)) throw new TypeError('Invalid worker instance identity');
  let current = await prepareNodeStorageDirectory(directory);
  for (const component of ['agent-data', 'instances', instanceId]) {
    current = path.join(current, component);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await assertPrivateDirectory(current);
  }
  return current;
}

/** Compiled Bun autoloads dotenv before main; an empty private cwd keeps that outside every configured home. */
export async function createNodeWorkerWorkingDirectory(storageDirectory: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const root = await prepareNodeStorageDirectory(storageDirectory);
  const directory = await mkdtemp(path.join(root, '.worker-'));
  return { path: directory, dispose: () => rm(directory, { recursive: true, force: true }) };
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new Error('Invalid worker private directory');
  }
}
