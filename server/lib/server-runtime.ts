import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  LOCAL_CAPABILITY_PREFIX,
  SERVER_RUNTIME_FILENAME,
  SERVER_RUNTIME_SCHEMA_VERSION,
  parseServerRuntimeDescriptor,
  type ServerRuntimeDescriptor,
  type ServerRuntimeIdentity,
} from '@garcon/common/server-runtime';

export interface ServerRuntimeState {
  identity: ServerRuntimeIdentity;
  localCapability: string;
}

export function createServerRuntimeState(workspaceDir: string): ServerRuntimeState {
  return {
    identity: {
      schemaVersion: SERVER_RUNTIME_SCHEMA_VERSION,
      instanceId: crypto.randomUUID(),
      workspaceDir,
      startedAt: new Date().toISOString(),
    },
    localCapability: `${LOCAL_CAPABILITY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`,
  };
}

export function advertisedServerUrl(bindAddress: string, port: number): string {
  let hostname = bindAddress;
  if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') hostname = '127.0.0.1';
  if (hostname.includes(':') && !hostname.startsWith('[')) hostname = `[${hostname}]`;
  return `http://${hostname}:${port}`;
}

export async function publishServerRuntime(
  state: ServerRuntimeState,
  baseUrl: string,
): Promise<{ descriptor: ServerRuntimeDescriptor; filePath: string }> {
  const workspaceDir = await fs.realpath(state.identity.workspaceDir);
  const descriptor: ServerRuntimeDescriptor = {
    ...state.identity,
    workspaceDir,
    pid: process.pid,
    baseUrl,
    localCapability: state.localCapability,
  };
  const filePath = path.join(workspaceDir, SERVER_RUNTIME_FILENAME);
  const tempPath = path.join(
    workspaceDir,
    `.${SERVER_RUNTIME_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const handle = await fs.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tempPath, filePath);
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { descriptor, filePath };
}

export async function removeServerRuntime(
  filePath: string,
  expectedInstanceId: string,
): Promise<boolean> {
  let descriptor: ServerRuntimeDescriptor;
  try {
    descriptor = parseServerRuntimeDescriptor(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return false;
  }
  if (descriptor.instanceId !== expectedInstanceId) return false;
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
