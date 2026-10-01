import { test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

// Keeps sockets that never start the encrypted handshake open against an executor
// endpoint, reopening each one the controller closes, as a peer without the secret can.
function holdUnfinishedHandshakes(url: string, count: number) {
  let holding = true;
  let opened = 0;
  const filled = Promise.withResolvers<void>();
  const sockets = new Set<WebSocket>();
  const open = () => {
    if (!holding) return;
    const socket = new WebSocket(url);
    sockets.add(socket);
    socket.addEventListener('open', () => { if (++opened === count) filled.resolve(); });
    socket.addEventListener('close', () => {
      sockets.delete(socket);
      if (holding) setTimeout(open, 25);
    });
  };
  for (let index = 0; index < count; index++) open();
  return {
    filled: filled.promise,
    release() {
      holding = false;
      for (const socket of sockets) socket.close();
    },
  };
}

function executorEndpoint(baseUrl: string, executorId: string): string {
  return `ws://${new URL(baseUrl).host}/executor/${executorId}`;
}

test('admits a restarted worker while other executors fill their endpoints with unfinished handshakes', async () => {
  await withIntegrationFixture('executor-admission-crowded-controller', async (fixture) => {
    const holders: ReturnType<typeof holdUnfinishedHandshakes>[] = [];
    try {
      for (let index = 0; index < 4; index++) {
        const crowded = await fixture.client.post<{ id: string }>('/api/v1/executors', {
          label: `Synthetic crowded executor ${index}`, direction: 'executor-connects', noTls: true,
        });
        holders.push(holdUnfinishedHandshakes(executorEndpoint(fixture.garcon.baseUrl, crowded.id), 4));
      }
      await Promise.all(holders.map((holder) => holder.filled));
      await fixture.crashAndRestartExecutorWorker();
    } finally {
      for (const holder of holders) holder.release();
    }
  }, { executionBackend: 'remote-executor-dials' });
}, 60_000);

test('admits a restarted worker while its own endpoint is kept full of unfinished handshakes', async () => {
  await withIntegrationFixture('executor-admission-crowded-endpoint', async (fixture) => {
    const holder = holdUnfinishedHandshakes(executorEndpoint(fixture.garcon.baseUrl, fixture.client.executorId), 4);
    try {
      await holder.filled;
      await fixture.crashAndRestartExecutorWorker();
    } finally {
      holder.release();
    }
  }, { executionBackend: 'remote-executor-dials' });
}, 60_000);
