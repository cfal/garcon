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
  const descriptorPath = path.join(workspaceDir, SERVER_RUNTIME_FILENAME);
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
  test('verifies the credential-free probe before returning the capability', async () => {
    const testFixture = await fixture();
    const authorizationHeaders: Array<string | null> = [];
    const connection = await discoverRuntime({
      configDir: testFixture.configDir,
      workspace: 'review',
    }, {
      fetch: async (input, init) => {
        authorizationHeaders.push(new Headers(init?.headers).get('authorization'));
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

    expect(authorizationHeaders).toEqual([null]);
    expect(connection).toEqual({
      baseUrl: 'http://127.0.0.1:8080',
      instanceId: testFixture.descriptor.instanceId,
      localCapability: testFixture.descriptor.localCapability,
      workspaceDir: testFixture.workspaceDir,
    });
  });

  test('re-reads the descriptor once when the runtime rotates', async () => {
    const testFixture = await fixture();
    const rotatedInstanceId = crypto.randomUUID();
    let probes = 0;
    const connection = await discoverRuntime({
      configDir: testFixture.configDir,
      workspace: 'review',
    }, {
      fetch: async (input) => {
        probes += 1;
        const capability = probes === 1
          ? String(testFixture.descriptor.localCapability)
          : String((JSON.parse(await fs.readFile(testFixture.descriptorPath, 'utf8')) as Record<string, unknown>).localCapability);
        return Response.json({
          schemaVersion: 1,
          instanceId: rotatedInstanceId,
          proof: runtimeProof(capability, rotatedInstanceId, input),
        });
      },
      delay: async () => {
        const rotated = {
          ...testFixture.descriptor,
          instanceId: rotatedInstanceId,
          localCapability: `${LOCAL_CAPABILITY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`,
        };
        await fs.writeFile(testFixture.descriptorPath, JSON.stringify(rotated), { mode: 0o600 });
      },
    });
    expect(probes).toBe(2);
    expect(connection.instanceId).toBe(rotatedInstanceId);
  });

  test('rejects a replayed instance identity without a fresh capability proof', async () => {
    const testFixture = await fixture();
    const replayedProof = crypto.randomBytes(32).toString('base64url');
    let authorization: string | null = null;

    await expect(discoverRuntime({
      configDir: testFixture.configDir,
      workspace: 'review',
    }, {
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return Response.json({
          schemaVersion: 1,
          instanceId: testFixture.descriptor.instanceId,
          proof: replayedProof,
        });
      },
      delay: async () => undefined,
    })).rejects.toThrow('does not match');

    expect(authorization).toBeNull();
  });

  test('rejects a server override before probing a different loopback peer', async () => {
    const testFixture = await fixture();
    let probes = 0;

    await expect(discoverRuntime({
      configDir: testFixture.configDir,
      workspace: 'review',
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
      workspace: 'review',
    }, { fetch: async () => Response.json({}) })).rejects.toThrow('secure runtime descriptor');
  });

  test('rejects a workspace symlink that escapes the config directory', async () => {
    if (process.platform === 'win32') return;
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cli-config-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cli-outside-'));
    roots.push(configDir, outside);
    await fs.symlink(outside, path.join(configDir, 'workspace-review'));
    await expect(discoverRuntime({ configDir, workspace: 'review' })).rejects.toThrow(
      'named workspace "review" is unavailable',
    );
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
