import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { Logger } from './log.js';
import {
  LOCAL_CAPABILITY_PREFIX,
  SERVER_RUNTIME_FILENAME,
  SERVER_RUNTIME_SCHEMA_VERSION,
  isRuntimeProbeChallenge,
  parseCliRuntimeDescriptor,
  runtimeProofPayload,
  type ServerRuntimeDescriptor,
  type ServerRuntimeIdentity,
  type CliRuntimeDescriptor,
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

export function createServerRuntimeProof(
  state: ServerRuntimeState,
  challenge: string,
): string {
  if (!isRuntimeProbeChallenge(challenge)) throw new Error('runtime challenge is invalid');
  return crypto.createHmac('sha256', state.localCapability)
    .update(runtimeProofPayload(state.identity.instanceId, challenge))
    .digest('base64url');
}

export function advertisedServerUrl(bindAddress: string, port: number): string {
  let hostname = bindAddress;
  if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') hostname = '127.0.0.1';
  return listeningServerUrl(hostname, port);
}

export function listeningServerUrl(bindAddress: string, port: number): string {
  let hostname = bindAddress;
  if (hostname.includes(':') && !hostname.startsWith('[')) hostname = `[${hostname}]`;
  return `http://${hostname}:${port}`;
}

export function logServerReady(
  logger: Pick<Logger, 'info' | 'warn'>,
  listener: { bindAddress: string; port: number; authDisabled: boolean },
): void {
  const { bindAddress, port, authDisabled } = listener;
  logger.info(`Started at ${listeningServerUrl(bindAddress, port)}`);
  logger.info(`Authentication: ${authDisabled ? 'DISABLED' : 'ENABLED'}`);
  if (authDisabled && bindAddress !== '127.0.0.1' && bindAddress !== 'localhost') {
    logger.warn('WARNING: authentication is disabled while bound to a non-localhost address.');
  }
}

export async function publishServerRuntime(
  state: ServerRuntimeState,
  baseUrl: string,
  configDir: string,
): Promise<{ descriptor: ServerRuntimeDescriptor; filePath: string }> {
  const workspaceDir = await fs.realpath(state.identity.workspaceDir);
  const descriptor: ServerRuntimeDescriptor = {
    ...state.identity,
    workspaceDir,
    pid: process.pid,
    baseUrl,
    localCapability: state.localCapability,
  };
  const filePath = path.join(configDir, SERVER_RUNTIME_FILENAME);
  await publishRuntimeDescriptor(filePath, descriptor);
  return { descriptor, filePath };
}

export async function publishRuntimeDescriptor(filePath: string, descriptor: CliRuntimeDescriptor): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const handle = await fs.open(tempPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8' });
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeServerRuntime(
  filePath: string,
  expectedInstanceId: string,
): Promise<boolean> {
  let descriptor: CliRuntimeDescriptor;
  try {
    descriptor = parseCliRuntimeDescriptor(JSON.parse(await fs.readFile(filePath, 'utf8')));
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
