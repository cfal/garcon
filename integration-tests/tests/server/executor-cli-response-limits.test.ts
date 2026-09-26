import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ControllerCliDispatcher } from '../../../server/controller/executors/cli-dispatcher.js';
import { CLI_EXECUTOR_ID } from '../../../server/remote/__tests__/cli-fixture.js';
import { linkOptions } from '../../../server/remote/__tests__/integration-fixture.js';
import { startCliGateway } from '../../../server/remote/server/cli-gateway.js';
import { CLI_REPLY_BYTES } from '../../../server/remote/transport/cli-protocol.js';
import { ExecutorRpc } from '../../../server/remote/transport/rpc.js';
import { WebSocketLink } from '../../../server/remote/transport/websocket-link.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`CLI HTTP gateway rejects and cancels oversized replies over Noise (${dialer} dials)`, async () => {
    const root = await mkdtemp(join(homedir(), 'cli-response-limits-'));
    const controller = new WebSocketLink({ ...linkOptions, executorId: CLI_EXECUTOR_ID, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, executorId: CLI_EXECUTOR_ID, role: 'worker' });
    let workerRpc: ExecutorRpc | null = null;
    let gateway: Awaited<ReturnType<typeof startCliGateway>> | undefined;
    let large = true;
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const respond = () => large ? new Response(new ReadableStream<Uint8Array>({
      pull(output) {
        if (pulls++ === 0) output.enqueue(new TextEncoder().encode('{"output":"'));
        else if (pulls <= 2 * CLI_REPLY_BYTES / chunk.byteLength) output.enqueue(chunk);
        else { output.enqueue(new TextEncoder().encode('"}')); output.close(); }
      },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json' } }) : Response.json({ output: 'small' });
    const dispatcher = new ControllerCliDispatcher({
      serverInstanceId: 'controller', workspaceName: null, isShuttingDown: () => false,
      routes: { '/api/v1/chats/export': { GET: respond }, '/api/v1/chats/run': { POST: respond } },
    });
    controller.onSession(session => {
      const rpc = new ExecutorRpc(session);
      rpc.handle(async (call, signal, guard) => {
        const access = { executorId: CLI_EXECUTOR_ID, rpc, signal, assertCurrent() {} };
        if (call.method === 'controllerCli.describe') return dispatcher.describe(access, guard);
        if (call.method === 'controllerCli.request') return dispatcher.request(call.request, access, guard);
        throw new Error('Unexpected reverse request');
      });
    });
    worker.onSession(session => { workerRpc = new ExecutorRpc(session); });
    try {
      if (dialer === 'controller') controller.dial(worker.listen());
      else worker.dial(controller.listen());
      await Promise.all([controller.ready, worker.ready]);
      gateway = await startCliGateway({ dataDir: join(root, 'executor'), currentRpc: () => workerRpc });
      const call = (mutation: boolean) => fetch(`${gateway!.descriptor.baseUrl}/api/v1/chats/${mutation ? 'run' : 'export'}`, {
        method: mutation ? 'POST' : 'GET', body: mutation ? '{}' : undefined,
        headers: { Authorization: `Bearer ${gateway!.descriptor.localCapability}`, 'X-Garcon-Server-Instance': 'controller', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      for (const mutation of [false, true]) {
        pulls = 0;
        cancelled = false;
        const response = await call(mutation);
        expect(response.status).toBe(mutation ? 503 : 413);
        expect(await response.json()).toMatchObject({ errorCode: mutation ? 'CLI_OUTCOME_UNKNOWN' : 'CLI_RESULT_TOO_LARGE' });
        expect(cancelled).toBe(true);
        expect(pulls).toBeLessThanOrEqual(CLI_REPLY_BYTES / chunk.byteLength + 2);
      }
      large = false;
      expect(await (await call(false)).json()).toEqual({ output: 'small' });
    } finally {
      await gateway?.dispose();
      await controller.dispose(); await worker.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
