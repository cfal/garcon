import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { cliGatewayRuntimeFile, executionNodeDataDirectory } from '@garcon/common/cli-runtime-paths';
import { runtimeProofPayload, type CliRuntimeDescriptor } from '@garcon/common/server-runtime';
import { parseCliArgs } from '../args.js';
import { discoverRuntime } from '../discovery.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const temporary = path.join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const configDir = await mkdtemp(path.join(temporary, 'cli-selection-'));
  roots.push(configDir);
  const endpoints = new Map<string, CliRuntimeDescriptor>();
  const calls: { url: URL; authorization: string | null }[] = [];
  async function add(workspace?: string) {
    const instanceId = crypto.randomUUID();
    const workspaceDir = workspace === undefined ? null : path.join(configDir, `workspace-${workspace}`);
    const runtimeFile = workspaceDir === null ? cliGatewayRuntimeFile(executionNodeDataDirectory(configDir), instanceId)
      : path.join(workspaceDir, 'server-runtime.json');
    const descriptor: CliRuntimeDescriptor = {
      schemaVersion: 1, instanceId, startedAt: '2026-01-01T00:00:00.000Z', pid: process.pid,
      baseUrl: `http://127.0.0.1:${8000 + endpoints.size}`, localCapability: `garcon_local_${crypto.randomBytes(32).toString('base64url')}`,
      ...(workspaceDir === null ? { kind: 'execution-node-cli' as const } : { workspaceDir }),
    };
    await mkdir(path.dirname(runtimeFile), { recursive: true, mode: 0o700 });
    await writeFile(runtimeFile, JSON.stringify(descriptor), { mode: 0o600 });
    endpoints.set(descriptor.baseUrl, descriptor);
    return { descriptor, runtimeFile };
  }
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
    const descriptor = endpoints.get(url.origin)!;
    if (url.pathname.endsWith('/cli/context')) return Response.json({ serverInstanceId: 'workspaceDir' in descriptor ? descriptor.instanceId : 'controller',
      defaultNodeId: 'workspaceDir' in descriptor ? 'local' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceName: 'work' });
    return Response.json({ schemaVersion: 1, instanceId: descriptor.instanceId, proof: crypto.createHmac('sha256', descriptor.localCapability)
      .update(runtimeProofPayload(descriptor.instanceId, url.searchParams.get('challenge')!)).digest('base64url') });
  }, { preconnect() {} }) satisfies typeof fetch;
  return { configDir, add, calls, fetch: fetcher };
}

test('root-only discovery selects a worker without an implicit default workspace', async () => {
  const f = await fixture();
  const worker = await f.add();
  for (const command of [parseCliArgs(['list', 'agents'], { GARCON_CONFIG_DIR: f.configDir }),
    parseCliArgs(['--config-dir', f.configDir, 'list', 'agents'], {})]) {
    if (command.kind !== 'list') throw new Error('Expected list command');
    expect(command.workspace).toBeUndefined();
    const connection = await discoverRuntime(command, { fetch: f.fetch });
    expect(connection.selector).toEqual({ runtimeFile: worker.runtimeFile });
    expect(connection.defaultNodeId).not.toBe('local');
  }
  expect(f.calls.map((call) => call.authorization)).toEqual([null, `Bearer ${worker.descriptor.localCapability}`, null, `Bearer ${worker.descriptor.localCapability}`]);
});

test('controller and worker are distinct candidates even when they share a workspace', async () => {
  const f = await fixture();
  const controller = await f.add('default');
  const worker = await f.add();
  await expect(discoverRuntime({ configDir: f.configDir }, { fetch: f.fetch })).rejects.toThrow('unique verified');
  expect(f.calls.every((call) => call.authorization === null)).toBe(true);
  expect((await discoverRuntime({ configDir: f.configDir, workspace: 'default' }, { fetch: f.fetch })).selector).toEqual({ workspace: 'default' });
  expect((await discoverRuntime({ configDir: f.configDir, runtimeFile: worker.runtimeFile }, { fetch: f.fetch })).endpointInstanceId).toBe(worker.descriptor.instanceId);
  await expect(discoverRuntime({ configDir: f.configDir, serverUrl: controller.descriptor.baseUrl }, { fetch: f.fetch })).rejects.toThrow('unique verified');
});

test('multiple workers require exact selectors without disclosing capabilities', async () => {
  const f = await fixture();
  const first = await f.add();
  const second = await f.add();
  let message = '';
  try { await discoverRuntime({ configDir: f.configDir }, { fetch: f.fetch }); }
  catch (error) { message = (error as Error).message; }
  expect(message).toContain(`garcon-cli --runtime-file '${first.runtimeFile}'`);
  expect(message).toContain(`garcon-cli --runtime-file '${second.runtimeFile}'`);
  expect(message).not.toContain('--config-dir');
  expect(message).not.toContain(first.descriptor.localCapability);
  expect(message).not.toContain(second.descriptor.localCapability);
  expect(f.calls.every((call) => call.authorization === null)).toBe(true);
});

test('refused and vanished descriptors are skipped but atomic temporary files are never probed', async () => {
  const f = await fixture();
  const dead = await f.add();
  const live = await f.add('work');
  await writeFile(`${dead.runtimeFile}.tmp`, 'not a descriptor');
  const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(dead.descriptor.baseUrl)) throw Object.assign(new Error('refused'), { code: 'ConnectionRefused' });
    return f.fetch(input, init);
  }, { preconnect() {} });
  expect((await discoverRuntime({ configDir: f.configDir }, { fetch: fetcher })).endpointInstanceId).toBe(live.descriptor.instanceId);
  await rm(dead.runtimeFile);
  expect((await discoverRuntime({ configDir: f.configDir }, { fetch: f.fetch })).selector).toEqual({ workspace: 'work' });
});

test.each(['timeout', 'reset', 'busy', 'proof', 'schema', 'permissions'])('unresolved %s blocks selecting another endpoint', async (failure) => {
  const f = await fixture();
  const suspect = await f.add();
  await f.add('work');
  if (failure === 'permissions' && process.platform === 'win32') return;
  if (failure === 'permissions') await chmod(suspect.runtimeFile, 0o644);
  if (failure === 'schema') await writeFile(suspect.runtimeFile, JSON.stringify({ ...suspect.descriptor, schemaVersion: 2 }));
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(suspect.descriptor.baseUrl)) {
      if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      if (failure === 'reset') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      if (failure === 'busy') return Response.json({ errorCode: 'CLI_SERVICE_BUSY' }, { status: 503 });
      if (failure === 'proof') return Response.json({ schemaVersion: 1, instanceId: suspect.descriptor.instanceId, proof: Buffer.alloc(32).toString('base64url') });
    }
    return f.fetch(input, init);
  }, { preconnect() {} }) satisfies typeof fetch;
  const error = await discoverRuntime({ configDir: f.configDir }, { fetch: fetcher, delay: async () => {} }).catch((caught: unknown) => caught);
  expect((error as Error).message).toContain(`(unverified at ${suspect.runtimeFile}: `);
  expect((error as Error).message).not.toContain(suspect.descriptor.localCapability);
  expect(f.calls.every((call) => call.authorization === null)).toBe(true);
});

test('non-directory workspace entries are ignored and unresolvable aliases block with a reason', async () => {
  const f = await fixture();
  await f.add('work');
  await writeFile(path.join(f.configDir, 'workspace-version.json'), '{}');
  await writeFile(path.join(f.configDir, 'workspace-default.tar'), '');
  expect((await discoverRuntime({ configDir: f.configDir }, { fetch: f.fetch })).selector).toEqual({ workspace: 'work' });
  if (process.platform === 'win32') return;
  const outside = await mkdtemp(path.join(path.dirname(f.configDir), 'cli-outside-'));
  roots.push(outside);
  await symlink(outside, path.join(f.configDir, 'workspace-outside'));
  const descriptorPath = path.join(f.configDir, 'workspace-outside', 'server-runtime.json');
  await expect(discoverRuntime({ configDir: f.configDir }, { fetch: f.fetch })).rejects.toThrow(
    `--workspace 'outside' --config-dir '${f.configDir}' (unverified at ${descriptorPath}: named workspace "outside" is unavailable`);
});

test.each([403, 503])('unique gateway context HTTP %s never falls back', async (status) => {
  const f = await fixture();
  await f.add();
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/cli/context')
    ? Response.json({ errorCode: 'CLI_ACCESS_DENIED' }, { status }) : f.fetch(input, init), { preconnect() {} }) satisfies typeof fetch;
  await expect(discoverRuntime({ configDir: f.configDir }, { fetch: fetcher })).rejects.toThrow(`HTTP ${status}`);
  await expect(discoverRuntime({ configDir: f.configDir, workspace: 'missing' }, { fetch: f.fetch })).rejects.toThrow('named workspace');
  await expect(discoverRuntime({ configDir: f.configDir, runtimeFile: path.join(f.configDir, 'missing.json') }, { fetch: f.fetch })).rejects.toThrow('secure runtime descriptor');
});

test('automatic discovery deduplicates canonical workspace aliases without following descriptor symlinks', async () => {
  if (process.platform === 'win32') return;
  const f = await fixture();
  const controller = await f.add('work');
  await symlink('workspace-work', path.join(f.configDir, 'workspace-alias'));
  expect((await discoverRuntime({ configDir: f.configDir }, { fetch: f.fetch })).selector).toEqual({ workspace: 'alias' });
  expect(f.calls).toHaveLength(2);
  const original = `${controller.runtimeFile}.original`;
  await writeFile(original, JSON.stringify(controller.descriptor), { mode: 0o600 });
  await rm(controller.runtimeFile);
  await symlink(original, controller.runtimeFile);
  await expect(discoverRuntime({ configDir: f.configDir }, { fetch: f.fetch })).rejects.toThrow('unverified');
});

test('discovery propagates cancellation and reports an empty root without falling back', async () => {
  const f = await fixture();
  await expect(discoverRuntime({ configDir: f.configDir }, { fetch: f.fetch })).rejects.toThrow('no running Garcon endpoint');
  await f.add();
  const abort = new AbortController();
  const fetcher = Object.assign(async () => { abort.abort(new Error('cancelled')); throw abort.signal.reason; }, { preconnect() {} }) satisfies typeof fetch;
  await expect(discoverRuntime({ configDir: f.configDir, signal: abort.signal }, { fetch: fetcher })).rejects.toThrow('cancelled');
});
