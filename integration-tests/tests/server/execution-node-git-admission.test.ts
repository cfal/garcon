import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GIT_MAX_CONCURRENT_QUERIES, type ExecutionGitResults } from '../../../common/git-execution.js';
import { withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-node-dials'] as const) {
  test(`Git admits a bounded burst of concurrent metadata reads (${executionBackend})`, async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let holding = false;
    let arrivals = 0;
    const barrier = Bun.serve({
      hostname: '0.0.0.0', port: 0,
      async fetch() {
        if (holding) {
          if (++arrivals === GIT_MAX_CONCURRENT_QUERIES) entered.resolve();
          await gate.promise;
        }
        return new Response('ready');
      },
    });
    try {
      await withIntegrationFixture(`git-admission-${executionBackend}`, async fixture => {
        const { client, executionDirs } = fixture;
        await initializeFixtureRepository(executionDirs.project);
        const endpoint = `/api/v1/git/status?${new URLSearchParams({ nodeId: client.nodeId, project: executionDirs.project })}`;
        holding = true;
        const pending = Array.from({ length: GIT_MAX_CONCURRENT_QUERIES }, () =>
          client.get<ExecutionGitResults['getStatus']>(endpoint).catch(error => {
            entered.reject(error);
            throw error;
          }));
        const settled = Promise.allSettled(pending);
        try {
          await withTimeout(entered.promise, 10_000, () => 'Concurrent Git reads did not reach their native probes');
          expect(arrivals).toBe(8);
          await expect(client.get(endpoint)).rejects.toMatchObject({ status: 503, body: { errorCode: 'GIT_SERVICE_BUSY' } });
          expect(arrivals).toBe(8);
        } finally {
          holding = false;
          gate.resolve();
          await settled;
        }
        for (const result of await Promise.all(pending)) expect(result).toMatchObject({ nodeId: client.nodeId, branch: 'main' });
        expect(await client.get(endpoint)).toMatchObject({ nodeId: client.nodeId, branch: 'main' });
      }, {
        executionBackend, projectRoots: 'separate',
        resolveServerEnvironment: dirs => ({ PATH: `${join(dirs.root, 'git-bin')}:${process.env.PATH}` }),
        prepareWorkspace: async dirs => {
          const bin = join(dirs.root, 'git-bin');
          await mkdir(bin);
          await writeFile(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--show-toplevel')) await fetch('http://127.0.0.1:${barrier.port}');
const child = Bun.spawn([${JSON.stringify(Bun.which('git'))}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
`, { mode: 0o755 });
        },
      });
    } finally {
      holding = false;
      gate.resolve();
      await barrier.stop(true);
    }
  }, 60_000);
}
