import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readWorkerCliOptions } from '../worker-cli.js';
import { parseConnectionUrl } from '../connection-url.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'worker-cli-'));
  roots.push(root);
  return root;
}

test('listener reuses a private persisted secret while connect takes the complete URL', async () => {
  const root = await workspace();
  const args = ['--listen', '0', '--allow-insecure-development', '--workspace-dir', root];
  const first = await readWorkerCliOptions(args);
  const restarted = await readWorkerCliOptions(args);
  expect(first.secret).toBe(restarted.secret);
  if (process.platform !== 'win32') expect((await stat(join(root, 'execution-node-secret.json'))).mode & 0o777).toBe(0o600);
  const full = `wss://example.com/execution-node/22222222-2222-4222-8222-222222222222#secret=${first.secret}`;
  const dialing = await readWorkerCliOptions(['--connect', full, '--workspace-dir', root]);
  expect(dialing.secret).toBe(first.secret);
  expect(dialing.connection).toEqual({ kind: 'dial', url: full.split('#')[0] });
  expect(dialing).not.toHaveProperty('nodeId');
  expect(dialing).not.toHaveProperty('label');
});

test('CLI validation does not disclose connection credentials', async () => {
  const secret = Buffer.alloc(32, 7).toString('base64url');
  for (const args of [[], ['--listen', 'NaN'], ['--listen', '99999'], ['--connect', secret, '--listen', '0'], ['--unexpected', secret]]) {
    let failure: unknown;
    try { await readWorkerCliOptions(args); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
  }
});

test('public worker starts, prints onboarding URL, and shuts down without a controller', async () => {
  const root = await workspace();
  const process = Bun.spawn(['bun', 'server/main.ts', 'execution-node', '--listen', '0', '--allow-insecure-development', '--workspace-dir', root], {
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Worker exited before listening');
      output += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    const listening = JSON.parse(output.split('\n')[0]!);
    expect(listening.type).toBe('execution-node-listening');
    expect(new URL(listening.url).hostname).toBe('0.0.0.0');
    expect(parseConnectionUrl(listening.connectionUrl).socketUrl).toBe(listening.url);
    process.kill('SIGTERM');
    expect(await process.exited).toBe(0);
  } finally {
    if (process.exitCode === null) process.kill('SIGTERM');
    await process.exited;
  }
}, 15_000);

test('private-config worker diagnostics do not disclose its credential', async () => {
  const root = await workspace();
  const secret = Buffer.alloc(32, 8).toString('base64url');
  const configPath = join(root, 'private.json');
  await writeFile(configPath, JSON.stringify({
    nodeId: 'test-node', secret, connection: { kind: 'listen', port: 0 },
    workspaceDir: root, projectBasePath: root, allowInsecureDevelopment: true,
  }), { mode: 0o600 });
  const child = Bun.spawn(['bun', 'server/execution-nodes/worker-main.ts', configPath], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  let output = '';
  try {
    const decoder = new TextDecoder();
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Worker exited before listening');
      output += decoder.decode(chunk.value, { stream: true });
    }
    expect(JSON.parse(output.split('\n')[0]!)).not.toHaveProperty('connectionUrl');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
  }
  output += await new Response(child.stderr).text();
  expect(output).not.toContain(secret);
  expect(child.exitCode).toBe(0);
}, 15_000);
