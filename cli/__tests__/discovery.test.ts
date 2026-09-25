import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LOCAL_CAPABILITY_PREFIX,
  SERVER_RUNTIME_FILENAME,
  SERVER_RUNTIME_SCHEMA_VERSION,
  runtimeProofPayload,
} from '@garcon/common/server-runtime';
import { discoverRuntime, parseLoopbackServerUrl } from '../discovery.js';

const roots: string[] = [];

function runtimeProof(
  capability: string,
  instanceId: string,
  requestUrl: string | URL | Request,
): string {
  const url = new URL(requestUrl instanceof Request ? requestUrl.url : requestUrl);
  const challenge = url.searchParams.get('challenge') ?? '';
  return crypto.createHmac('sha256', capability)
    .update(runtimeProofPayload(instanceId, challenge))
    .digest('base64url');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(overrides: Record<string, unknown> = {}): Promise<{
  configDir: string;
  workspaceDir: string;
  descriptorPath: string;
  descriptor: Record<string, unknown>;
}> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cli-discovery-'));
  roots.push(configDir);
  const workspaceDir = path.join(configDir, 'workspace-review');
  await fs.mkdir(workspaceDir);
  const directory = overrides.kind === 'execution-node-cli' ? path.join(configDir, 'execution-node') : configDir;
  await fs.mkdir(directory, { recursive: true });
  const descriptorPath = path.join(directory, SERVER_RUNTIME_FILENAME);
  const descriptor = {
    schemaVersion: SERVER_RUNTIME_SCHEMA_VERSION,
    instanceId: crypto.randomUUID(),
    workspaceDir,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    baseUrl: 'http://127.0.0.1:8080',
    localCapability: `${LOCAL_CAPABILITY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`,
    ...overrides,
  };
  await fs.writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  return { configDir, workspaceDir, descriptorPath, descriptor };
}

describe('discoverRuntime', () => {
  test('explicit gateway discovery separates endpoint and controller identities without a local workspace', async () => {
    const testFixture = await fixture({ kind: 'execution-node-cli', workspaceDir: undefined });
    const nodeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const options = { configDir: testFixture.configDir, runtime: 'execution-node' as const };
    const fetch: typeof globalThis.fetch = async (input) => String(input).endsWith('/cli/context')
      ? Response.json({ serverInstanceId: 'controller', defaultNodeId: nodeId, workspaceName: null })
      : Response.json({ schemaVersion: 1, instanceId: testFixture.descriptor.instanceId,
        proof: runtimeProof(String(testFixture.descriptor.localCapability), String(testFixture.descriptor.instanceId), input) });
    expect(await discoverRuntime(options, { fetch })).toMatchObject({
      instanceId: 'controller', endpointInstanceId: testFixture.descriptor.instanceId,
      defaultNodeId: nodeId, workspaceName: null, workspaceDir: null,
    });
    await expect(discoverRuntime({ ...options, runtime: 'controller' }, { fetch })).rejects.toThrow('no controller runtime file');
    if (process.platform !== 'win32') {
      await fs.rename(testFixture.descriptorPath, `${testFixture.descriptorPath}.real`);
      await fs.symlink(`${testFixture.descriptorPath}.real`, testFixture.descriptorPath);
      await expect(discoverRuntime(options, { fetch })).rejects.toThrow('symbolic link');
    }
  });
  test('verifies the credential-free probe before returning the capability', async () => {
    const testFixture = await fixture();
    const authorizationHeaders: Array<string | null> = [];
    const connection = await discoverRuntime({
      configDir: testFixture.configDir,
      runtime: 'controller',
    }, {
      fetch: async (input, init) => {
        authorizationHeaders.push(new Headers(init?.headers).get('authorization'));
        if (String(input).endsWith('/cli/context')) return Response.json({ serverInstanceId: testFixture.descriptor.instanceId, defaultNodeId: 'local', workspaceName: 'review' });
        return Response.json({
          schemaVersion: SERVER_RUNTIME_SCHEMA_VERSION,
          instanceId: testFixture.descriptor.instanceId,
          proof: runtimeProof(
            String(testFixture.descriptor.localCapability),
            String(testFixture.descriptor.instanceId),
            input,
          ),
        });
      },
    });

    expect(authorizationHeaders).toEqual([null, `Bearer ${testFixture.descriptor.localCapability}`]);
    expect(connection).toEqual({
      baseUrl: 'http://127.0.0.1:8080',
      instanceId: testFixture.descriptor.instanceId,
      endpointInstanceId: testFixture.descriptor.instanceId,
      defaultNodeId: 'local',
      workspaceName: 'review',
      localCapability: testFixture.descriptor.localCapability,
      workspaceDir: testFixture.workspaceDir,
      selector: { runtime: 'controller' },
    });
  });

  test('a replacement during proof cannot change the selected endpoint snapshot', async () => {
    const testFixture = await fixture();
    const rotatedInstanceId = crypto.randomUUID();
    let probes = 0;
    await expect(discoverRuntime({
      configDir: testFixture.configDir,
      runtime: 'controller',
    }, {
      fetch: async (input) => {
        probes += 1;
        const capability = `${LOCAL_CAPABILITY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
        await fs.writeFile(testFixture.descriptorPath, JSON.stringify({ ...testFixture.descriptor,
          instanceId: rotatedInstanceId, localCapability: capability }), { mode: 0o600 });
        return Response.json({
          schemaVersion: 1,
          instanceId: rotatedInstanceId,
          proof: runtimeProof(capability, rotatedInstanceId, input),
        });
      },
    })).rejects.toThrow('does not match');
    expect(probes).toBe(1);
  });

  test('rejects a replayed instance identity without a fresh capability proof', async () => {
    const testFixture = await fixture();
    const replayedProof = crypto.randomBytes(32).toString('base64url');
    let authorization: string | null = null;

    await expect(discoverRuntime({
      configDir: testFixture.configDir,
      runtime: 'controller',
    }, {
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return Response.json({
          schemaVersion: 1,
          instanceId: testFixture.descriptor.instanceId,
          proof: replayedProof,
        });
      },
    })).rejects.toThrow('does not match');

    expect(authorization).toBeNull();
  });

  test('rejects a server override before probing a different loopback peer', async () => {
    const testFixture = await fixture();
    let probes = 0;

    await expect(discoverRuntime({
      configDir: testFixture.configDir,
      runtime: 'controller',
      serverUrl: 'http://127.0.0.1:9090',
    }, {
      fetch: async () => {
        probes += 1;
        return Response.json({});
      },
    })).rejects.toThrow('must exactly match');

    expect(probes).toBe(0);
  });

  test('rejects descriptors readable by other users', async () => {
    if (process.platform === 'win32') return;
    const testFixture = await fixture();
    await fs.chmod(testFixture.descriptorPath, 0o644);
    await expect(discoverRuntime({
      configDir: testFixture.configDir,
      runtime: 'controller',
    }, { fetch: async () => Response.json({}) })).rejects.toThrow('readable only by its owner');
  });

  test('reports an actionable upgrade diagnostic for an unsupported descriptor schema', async () => {
    const testFixture = await fixture({ schemaVersion: 2 });

    await expect(discoverRuntime({
      configDir: testFixture.configDir,
      runtime: 'controller',
    })).rejects.toThrow('upgrade Garcon and garcon-cli together');
  });

  test('workspace location and name do not participate in runtime selection', async () => {
    if (process.platform === 'win32') return;
    const testFixture = await fixture();
    const targetWorkspaceDir = `${testFixture.workspaceDir}-target`;
    await fs.rename(testFixture.workspaceDir, targetWorkspaceDir);
    await fs.symlink(path.basename(targetWorkspaceDir), testFixture.workspaceDir, 'dir');
    const descriptor = {
      ...testFixture.descriptor,
      workspaceDir: targetWorkspaceDir,
    };
    await fs.writeFile(
      testFixture.descriptorPath,
      JSON.stringify(descriptor),
      { mode: 0o600 },
    );

    const connection = await discoverRuntime({
      configDir: testFixture.configDir,
      runtime: 'controller',
    }, {
      fetch: async (input) => String(input).endsWith('/cli/context')
        ? Response.json({ serverInstanceId: descriptor.instanceId, defaultNodeId: 'local', workspaceName: 'review-target' })
        : Response.json({
        schemaVersion: SERVER_RUNTIME_SCHEMA_VERSION,
        instanceId: descriptor.instanceId,
        proof: runtimeProof(
          String(descriptor.localCapability),
          String(descriptor.instanceId),
          input,
        ),
      }),
    });

    expect(connection.workspaceDir).toBe(targetWorkspaceDir);
    expect(connection.workspaceName).toBe('review-target');
  });

  test('supports config directory aliases without scanning workspace directories', async () => {
    if (process.platform === 'win32') return;
    const f = await fixture();
    const alias = `${f.configDir}-alias`;
    roots.push(alias);
    await fs.symlink(f.configDir, alias, 'dir');
    const fetch: typeof globalThis.fetch = async (input) => String(input).endsWith('/cli/context')
      ? Response.json({ serverInstanceId: f.descriptor.instanceId, defaultNodeId: 'local', workspaceName: 'review' })
      : Response.json({ schemaVersion: 1, instanceId: f.descriptor.instanceId,
        proof: runtimeProof(String(f.descriptor.localCapability), String(f.descriptor.instanceId), input) });
    expect((await discoverRuntime({ configDir: alias }, { fetch })).instanceId).toBe(f.descriptor.instanceId);
  });
});

describe('parseLoopbackServerUrl', () => {
  test.each(['http://localhost:8080', 'https://127.0.0.2:9000', 'http://[::1]:8080'])('%s is local', (url) => {
    expect(parseLoopbackServerUrl(url)).toBe(url);
  });

  test.each(['http://example.com', 'file:///tmp/socket', 'http://user@localhost:8080', 'http://localhost:8080/api'])('%s is rejected', (url) => {
    expect(() => parseLoopbackServerUrl(url)).toThrow();
  });
});
