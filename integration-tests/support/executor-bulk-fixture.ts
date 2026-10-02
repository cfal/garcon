import { expect } from 'bun:test';
import type { ExecutorSnapshot } from '../../common/executors.js';
import type { ExecutorsChangedMessage } from '../../common/ws-events.js';
import { tcpLinkProxy, type ProxyConnection } from '../../server/remote/__tests__/tcp-link-proxy.js';
import { withIntegrationFixture, type IntegrationFixture } from './integration-fixture.js';

export const BULK_BACKENDS = ['remote-controller-dials', 'remote-executor-dials'] as const;
export type BulkBackend = typeof BULK_BACKENDS[number];

export async function waitForBulk(fixture: IntegrationFixture, availability: NonNullable<ExecutorSnapshot['bulk']>['availability'] = 'ready') {
  const { client } = fixture;
  const afterIndex = client.markEvents();
  const matches = (executor: ExecutorSnapshot) => executor.id === client.executorId && executor.bulk?.availability === availability;
  const { executors } = await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
  if (executors.some(matches)) return;
  await client.waitForEvent((event): event is ExecutorsChangedMessage => event.type === 'executors-changed' && event.executors.some(matches),
    `bulk ${availability}`, { afterIndex, timeoutMs: 30_000 });
}

export async function withBulkFixture(
  name: string,
  executionBackend: BulkBackend,
  run: (fixture: IntegrationFixture, proxy: Awaited<ReturnType<typeof tcpLinkProxy>>, primary: ProxyConnection, bulk: ProxyConnection) => Promise<void>,
) {
  let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
  try {
    await withIntegrationFixture(`${name}-${executionBackend}`, async fixture => {
      await waitForBulk(fixture);
      // The authorized subordinate dial follows primary installation; no URL role marker is used.
      expect(proxy!.activeConnectionIds).toEqual([1, 2]);
      try { await run(fixture, proxy!, proxy!.capture(1), proxy!.capture(2)); }
      finally { proxy!.restore(); }
    }, {
      executionBackend, projectRoots: 'separate',
      serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' },
      interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; },
    });
  } finally { await proxy?.close(); }
}

export function observePending<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.finally(() => { settled = true; });
  void result.catch(() => undefined);
  return { result, get settled() { return settled; } };
}
