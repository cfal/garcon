import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  advertisedServerUrl,
  createServerRuntimeState,
  publishServerRuntime,
  removeServerRuntime,
} from '../server-runtime.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('server runtime publication', () => {
  it('publishes an owner-only descriptor and removes its own instance', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-runtime-'));
    tempDirs.push(workspaceDir);
    const state = createServerRuntimeState(workspaceDir);

    const published = await publishServerRuntime(state, 'http://127.0.0.1:4321');

    expect(published.descriptor.instanceId).toBe(state.identity.instanceId);
    expect(published.descriptor.localCapability).toBe(state.localCapability);
    if (process.platform !== 'win32') {
      expect((await fs.lstat(published.filePath)).mode & 0o077).toBe(0);
    }
    expect(await removeServerRuntime(published.filePath, state.identity.instanceId)).toBe(true);
    await expect(fs.lstat(published.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a descriptor replaced by another instance', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-runtime-'));
    tempDirs.push(workspaceDir);
    const state = createServerRuntimeState(workspaceDir);
    const published = await publishServerRuntime(state, 'http://127.0.0.1:4321');
    const replacement = { ...published.descriptor, instanceId: 'replacement' };
    await fs.writeFile(published.filePath, JSON.stringify(replacement), { mode: 0o600 });

    expect(await removeServerRuntime(published.filePath, state.identity.instanceId)).toBe(false);
    expect(JSON.parse(await fs.readFile(published.filePath, 'utf8')).instanceId).toBe('replacement');
  });

  it('advertises wildcard listeners through loopback', () => {
    expect(advertisedServerUrl('0.0.0.0', 8080)).toBe('http://127.0.0.1:8080');
    expect(advertisedServerUrl('::', 8080)).toBe('http://127.0.0.1:8080');
  });
});
