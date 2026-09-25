import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { cliRuntimeFile, type RuntimeKind } from '@garcon/common/cli-runtime-paths';
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
  const warnings: string[] = [];
  async function add(kind: RuntimeKind, startedAt = '2026-01-01T00:00:00.000Z') {
    const runtimeFile = cliRuntimeFile(configDir, kind);
    const descriptor: CliRuntimeDescriptor = {
      schemaVersion: 1, instanceId: crypto.randomUUID(), startedAt, pid: process.pid,
      baseUrl: `http://127.0.0.1:${8000 + endpoints.size}`, localCapability: `garcon_local_${crypto.randomBytes(32).toString('base64url')}`,
      ...(kind === 'execution-node' ? { kind: 'execution-node-cli' as const } : { workspaceDir: '/controller/workspace' }),
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
  return { configDir, add, calls, warnings, dependencies: { fetch: fetcher, warn: (message: string) => warnings.push(message) } };
}

test.each(['controller', 'execution-node'] as const)('auto selects the sole %s and sends its capability only after proof', async (runtime) => {
  const f = await fixture();
  const endpoint = await f.add(runtime);
  const command = parseCliArgs(['--config-dir', f.configDir, 'list', 'agents'], {});
  if (command.kind !== 'list') throw new Error('Expected list command');
  expect(command.runtime).toBe('auto');
  const connection = await discoverRuntime(command, f.dependencies);
  expect(connection.selector).toEqual({ runtime });
  expect(connection.endpointInstanceId).toBe(endpoint.descriptor.instanceId);
  expect(f.calls.map((call) => call.authorization)).toEqual([null, `Bearer ${endpoint.descriptor.localCapability}`]);
  expect(f.warnings).toEqual([]);
});

test.each(['controller', 'execution-node'] as const)('auto prefers the newer %s start, not file mtime, and warns without credentials', async (runtime) => {
  const f = await fixture();
  const older = await f.add(runtime === 'controller' ? 'execution-node' : 'controller');
  const newer = await f.add(runtime, '2026-02-01T00:00:00.000Z');
  await utimes(newer.runtimeFile, new Date(0), new Date(0));
  const connection = await discoverRuntime({ configDir: f.configDir }, f.dependencies);
  expect(connection.selector).toEqual({ runtime });
  expect(f.calls.every((call) => call.url.origin === newer.descriptor.baseUrl)).toBe(true);
  expect(f.warnings).toHaveLength(1);
  expect(f.warnings[0]).toContain(`both runtime files exist; selected ${runtime}`);
  expect(f.warnings[0]).toContain('--runtime controller or --runtime execution-node');
  expect(f.warnings[0]).not.toContain(newer.descriptor.localCapability);
  expect(f.warnings[0]).not.toContain(older.descriptor.localCapability);
});

test('equal start timestamps select controller deterministically', async () => {
  const f = await fixture();
  await f.add('execution-node');
  await f.add('controller');
  expect((await discoverRuntime({ configDir: f.configDir }, f.dependencies)).selector.runtime).toBe('controller');
});

test.each(['controller', 'execution-node'] as const)('explicit %s selection ignores newer and malformed files for the other role', async (runtime) => {
  const f = await fixture();
  await f.add(runtime);
  const other = await f.add(runtime === 'controller' ? 'execution-node' : 'controller', '2026-02-01T00:00:00Z');
  await writeFile(other.runtimeFile, 'invalid json');
  expect((await discoverRuntime({ configDir: f.configDir, runtime }, f.dependencies)).selector).toEqual({ runtime });
  expect(f.warnings).toEqual([]);
  await rm(cliRuntimeFile(f.configDir, runtime));
  await expect(discoverRuntime({ configDir: f.configDir, runtime }, f.dependencies)).rejects.toThrow(`no ${runtime} runtime file`);
});

test.each(['refused', 'timeout', 'reset', 'busy', 'proof', 'context'])('selected %s failure never falls back to the older runtime', async (failure) => {
  const f = await fixture();
  const older = await f.add('controller');
  const selected = await f.add('execution-node', '2026-02-01T00:00:00Z');
  const attempted: string[] = [];
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    attempted.push(String(input));
    if (failure === 'refused') throw Object.assign(new Error('refused'), { code: 'ConnectionRefused' });
    if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
    if (failure === 'reset') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    if (failure === 'busy' || failure === 'context' && String(input).endsWith('/cli/context')) return new Response('', { status: 503 });
    if (failure === 'proof') return Response.json({ schemaVersion: 1, instanceId: older.descriptor.instanceId, proof: Buffer.alloc(32).toString('base64url') });
    return f.dependencies.fetch(input, init);
  }, { preconnect() {} }) satisfies typeof fetch;
  await expect(discoverRuntime({ configDir: f.configDir }, { ...f.dependencies, fetch: fetcher })).rejects.toThrow();
  expect(attempted.length).toBeGreaterThan(0);
  expect(attempted.every((url) => url.startsWith(selected.descriptor.baseUrl))).toBe(true);
  expect(f.warnings).toHaveLength(1);
  expect(await Bun.file(selected.runtimeFile).exists()).toBe(true);
});

test.each(['schema', 'permissions', 'json', 'timestamp', 'kind', 'symlink'])('invalid %s metadata blocks auto without leaking the capability', async (failure) => {
  if ((failure === 'permissions' || failure === 'symlink') && process.platform === 'win32') return;
  const f = await fixture();
  const suspect = await f.add('execution-node');
  await f.add('controller', '2026-02-01T00:00:00Z');
  if (failure === 'permissions') await chmod(suspect.runtimeFile, 0o644);
  if (failure === 'schema') await writeFile(suspect.runtimeFile, JSON.stringify({ ...suspect.descriptor, schemaVersion: 2 }));
  if (failure === 'timestamp') await writeFile(suspect.runtimeFile, JSON.stringify({ ...suspect.descriptor, startedAt: 'not a timestamp' }));
  if (failure === 'kind') await writeFile(suspect.runtimeFile, JSON.stringify({ ...suspect.descriptor, kind: undefined, workspaceDir: '/other' }));
  if (failure === 'json') await writeFile(suspect.runtimeFile, `{"${suspect.descriptor.localCapability}`);
  if (failure === 'symlink') {
    await writeFile(`${suspect.runtimeFile}.real`, JSON.stringify(suspect.descriptor), { mode: 0o600 });
    await rm(suspect.runtimeFile);
    await symlink(`${suspect.runtimeFile}.real`, suspect.runtimeFile);
  }
  const error = await discoverRuntime({ configDir: f.configDir }, f.dependencies).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(suspect.runtimeFile);
  expect(String(error)).not.toContain(suspect.descriptor.localCapability);
  expect(f.calls).toEqual([]);
  expect(f.warnings).toHaveLength(1);
});

test('ignores workspace descriptors and temporary files; --server is an assertion, not a selector', async () => {
  const f = await fixture();
  await mkdir(path.join(f.configDir, 'workspace-default'));
  await writeFile(path.join(f.configDir, 'workspace-default', 'runtime.json'), 'ignored');
  await writeFile(path.join(f.configDir, '.runtime.json.tmp'), 'ignored');
  await expect(discoverRuntime({ configDir: f.configDir }, f.dependencies)).rejects.toThrow('no Garcon runtime file');
  const controller = await f.add('controller');
  await f.add('execution-node', '2026-02-01T00:00:00Z');
  await expect(discoverRuntime({ configDir: f.configDir, serverUrl: controller.descriptor.baseUrl }, f.dependencies)).rejects.toThrow('must exactly match');
  expect(f.calls).toEqual([]);
});

test('discovery cancellation propagates without selecting another runtime', async () => {
  const f = await fixture();
  await f.add('execution-node');
  const abort = new AbortController();
  const fetcher = Object.assign(async () => { abort.abort(new Error('cancelled')); throw abort.signal.reason; }, { preconnect() {} }) satisfies typeof fetch;
  await expect(discoverRuntime({ configDir: f.configDir, signal: abort.signal }, { ...f.dependencies, fetch: fetcher })).rejects.toThrow('cancelled');
});

test.each([
  { runtime: 'auto' as const, both: false, suggestOther: false },
  { runtime: 'auto' as const, both: true, suggestOther: true },
  { runtime: 'execution-node' as const, both: false, suggestOther: false },
  { runtime: 'execution-node' as const, both: true, suggestOther: false },
])('failed discovery suggests another role only after auto found it: %j', async ({ runtime, both, suggestOther }) => {
  const f = await fixture();
  if (both) await f.add('controller');
  const selected = await f.add('execution-node', '2026-02-01T00:00:00Z');
  const fetcher = Object.assign(async () => { throw new Error('refused'); }, { preconnect() {} }) satisfies typeof fetch;
  const error = await discoverRuntime({ configDir: f.configDir, runtime }, { ...f.dependencies, fetch: fetcher })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(`execution-node runtime at ${selected.runtimeFile}`);
  expect(String(error)).toContain('No fallback was attempted');
  if (suggestOther) expect(String(error)).toContain('--runtime controller only if you intend to switch roles');
  else {
    expect(String(error)).not.toContain('--runtime controller');
    expect(String(error)).toContain('restart it if it has exited');
  }
});
