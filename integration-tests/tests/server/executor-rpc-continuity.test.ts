import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadTextResponse, SaveTextResponse } from '../../../common/file-contracts.js';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`a file save sent into a silent link is saved once the executor reconnects (${executionBackend})`, async () => {
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    try {
      await withIntegrationFixture(`rpc-continuity-save-${executionBackend}`, async (fixture) => {
        const { client } = fixture;
        const projectPath = fixture.executionDirs.project;
        const file = join(projectPath, 'file.txt');
        await writeFile(file, 'original');
        const route = `/api/v1/files/text?${new URLSearchParams({ executorId: client.executorId, projectPath, path: 'file.txt' })}`;
        const before = await client.get<ReadTextResponse>(route);
        const cursor = client.markEvents();

        // The worker never receives the save while the link is silent.
        proxy!.blackhole();
        const saving = client.put<SaveTextResponse>(route, {
          content: 'Synthetic content saved across a blip', expectedRevision: before.revision, conflictResolution: 'reject',
        });
        await Bun.sleep(300);
        expect(await readFile(file, 'utf8')).toBe('original');
        proxy!.restore();
        proxy!.disconnect();

        const saved = await saving;
        expect(saved.revision).not.toBe(before.revision);
        expect(await readFile(file, 'utf8')).toBe('Synthetic content saved across a blip');
        expect(client.eventsSince(cursor).some((event) => event.type === 'executors-changed'
          && event.executors.some((executor) => executor.id === client.executorId && executor.availability === 'reconnecting'))).toBe(true);
        expect(proxy!.connections).toBe(2);
      }, {
        executionBackend,
        projectRoots: 'separate',
        interceptExecutorConnection: async (url) => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { await proxy?.close(); }
  }, 60_000);
}
