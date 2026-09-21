import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRpc } from '../../../server/execution-nodes/rpc.js';
import { WebSocketLink } from '../../../server/execution-nodes/websocket-link.js';
import { parseConnectionUrl } from '../../../server/execution-nodes/connection-url.js';
import { ExecutionNodeProcess } from '../../support/execution-backend.js';
import { withTimeout } from '../../support/deferred.js';

test('worker restart removes crashed uploads but leaves another live worker able to commit', async () => {
  const root = await mkdtemp(join(homedir(), 'tmp', 'garcon-file-staging-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const staging = join(home, '.cache', 'garcon', 'file-transfers');
  await mkdir(project);
  await writeFile(join(project, 'file.txt'), 'original');
  const workers: ExecutionNodeProcess[] = [];
  const links: WebSocketLink[] = [];
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const start = async (name: string) => {
    const worker = await ExecutionNodeProcess.start({
      repoRoot, directories: { root, home, project, config: join(root, name, 'config'), workspace: join(root, name, 'workspace') },
      environment: {}, connection: { kind: 'listen', port: 0 },
    });
    workers.push(worker);
    await worker.listening();
    return worker;
  };
  const connect = async (worker: ExecutionNodeProcess) => {
    const { socketUrl, secret } = parseConnectionUrl(await worker.connectionUrl());
    const link = new WebSocketLink({ role: 'controller', nodeId: crypto.randomUUID(), secret, allowInsecureDevelopment: true });
    links.push(link);
    const url = new URL(socketUrl);
    url.hostname = '127.0.0.1';
    link.dial(url.href);
    return new AgentRpc(await withTimeout(link.ready, 10_000, () => 'Worker handshake did not finish'));
  };
  try {
    const crashed = await start('crashed');
    const crashedRpc = await connect(crashed);
    const live = await start('live');
    const liveRpc = await connect(live);
    const request = { projectPath: project, filePath: 'file.txt', size: 7, expectedRevision: 'v1:initial', conflictResolution: 'overwrite' as const };
    const lost = await crashedRpc.call('', 'files.beginWrite', request);
    await crashedRpc.call('', 'files.writeChunk', { transfer: lost, offset: 0, data: Buffer.from('crashed').toString('base64') });
    const retained = await liveRpc.call('', 'files.beginWrite', request);
    await liveRpc.call('', 'files.writeChunk', { transfer: retained, offset: 0, data: Buffer.from('survive').toString('base64') });
    const staged = await readdir(staging);
    expect(staged).toHaveLength(2);
    const liveDirectory = staged.find((name) => name.includes(`-${live.child.pid}-`))!;
    expect(liveDirectory).toBeDefined();
    await crashed.crash();
    await links[0].dispose();

    // Cleanup runs on public worker startup, before a controller connects or another upload starts.
    await start('replacement');
    const deadline = Date.now() + 5_000;
    while ((await readdir(staging)).length !== 1 && Date.now() < deadline) await Bun.sleep(20);
    expect(await readdir(staging)).toEqual([liveDirectory]);
    expect(await readFile(join(staging, liveDirectory, 'content'), 'utf8')).toBe('survive');
    expect(await readFile(join(project, 'file.txt'), 'utf8')).toBe('original');
    expect((await liveRpc.call('', 'files.commitWrite', retained)).success).toBe(true);
    expect(await readFile(join(project, 'file.txt'), 'utf8')).toBe('survive');
    expect(await readdir(staging)).toEqual([]);
  } finally {
    for (const link of links) await link.dispose();
    for (const worker of workers) await worker.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
