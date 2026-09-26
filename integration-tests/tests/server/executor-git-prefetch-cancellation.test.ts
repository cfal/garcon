import { expect, spyOn, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGitResults } from '../../../common/git-execution.js';
import { gitRpcFixture } from '../../../server/remote/__tests__/git-rpc-fixture.js';
import * as bodies from '../../../server/runtime/git/review-diff-batch.js';
import { withTimeout } from '../../support/deferred.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`cancelled remote prefetches release read admission while the first load remains active (${dialer} dials)`, async () => {
    const fixture = await gitRpcFixture(dialer);
    const git = await fixture.executor.getGitService();
    const local = await fixture.local.getGitService();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let held = false;
    let boundCount = 0;
    let cancelledCount = 0;
    const originalLoad = bodies.loadReviewDiffBatches;
    const load = spyOn(bodies, 'loadReviewDiffBatches').mockImplementation(async (...args) => {
      if (!held) { held = true; entered.resolve(); await release.promise; }
      return originalLoad(...args);
    });
    const originalBind = AsyncResource.bind;
    const bind = spyOn(AsyncResource, 'bind').mockImplementation((fn, type, thisArg) => {
      const bound = originalBind(fn, type, thisArg);
      if (++boundCount === 8) queued.resolve();
      return bound;
    });
    const originalRead = local.getReviewDocumentFileBodies.bind(local);
    const read = spyOn(local, 'getReviewDocumentFileBodies').mockImplementation(async (...args) => {
      try { return await originalRead(...args); }
      finally {
        if (args[1]?.signal?.aborted && ++cancelledCount === 7) cancelled.resolve();
      }
    });
    const controllers = Array.from({ length: 7 }, () => new AbortController());
    const pending: Promise<unknown>[] = [];
    let first: Promise<ExecutionGitResults['getReviewDocumentFileBodies']> | undefined;
    try {
      await writeFile(join(fixture.projectPath, 'example.txt'), 'changed\n');
      const target = { projectPath: fixture.projectPath };
      const snapshot = await git.getWorkbenchSnapshot({ ...target, mode: 'working', context: 3 });
      if (snapshot.status !== 'ready') throw new Error('Expected repository');
      const request = {
        ...target, files: ['example.txt'], purpose: 'prefetch' as const,
        document: { executorId: snapshot.executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId },
      };
      first = git.getReviewDocumentFileBodies(request);
      await withTimeout(entered.promise, 3000, () => 'First prefetch did not start');
      for (const controller of controllers) {
        pending.push(git.getReviewDocumentFileBodies(request, { signal: controller.signal }).catch(error => error));
      }
      await withTimeout(queued.promise, 3000, () => 'Prefetches did not enter the queue');
      await expect(git.getStatus(target)).rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
      controllers.forEach(controller => controller.abort());
      await withTimeout(cancelled.promise, 3000, () => 'Cancelled prefetches still hold read admission');
      expect((await git.getStatus(target)).branch).toBe('main');
      expect(load).toHaveBeenCalledTimes(1);
      release.resolve();
      expect((await first).status).toBe('ready');
    } finally {
      controllers.forEach(controller => controller.abort());
      release.resolve();
      await Promise.allSettled([first, ...pending]);
      load.mockRestore(); bind.mockRestore(); read.mockRestore();
      await fixture.dispose();
    }
  }, 15_000);
}
