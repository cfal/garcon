import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecutorManager } from '../../../server/controller/executors/manager.js';
import { createProjectResolutionRoutes } from '../../../server/controller/routes/project-resolution.js';
import { remoteFixture } from '../../../server/remote/__tests__/integration-fixture.js';
import { ProjectService } from '../../../server/runtime/projects/project-service.js';
import { withTimeout } from '../../support/deferred.js';

for (const dialer of ['local', 'controller', 'worker'] as const) {
  test(`HTTP cancellation reaches the project inspector (${dialer})`, async () => {
    const root = await mkdtemp(join(homedir(), 'project-http-cancel-'));
    const manager = await ExecutorManager.create({
      id: 'local', workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const handled = Promise.withResolvers<number>();
    const service = new ProjectService(root, options => options?.signal?.throwIfAborted());
    const inspect = spyOn(service, 'inspect').mockImplementation(async (_input, options) => {
      const onAbort = () => { cancelled.resolve(); release.resolve(); };
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      entered.resolve();
      try {
        await release.promise;
        options?.signal?.throwIfAborted();
        return { resolution: { kind: 'available', effectiveProjectKey: root } };
      } finally {
        options?.signal?.removeEventListener('abort', onAbort);
      }
    });
    const remote = dialer === 'local' ? null : await remoteFixture(dialer, (_controller, _worker, provider) => {
      provider.executor.getProjectService = async () => service;
    }, root);
    const projectService = spyOn(manager, 'projectService').mockImplementation(async () =>
      remote ? remote.executor.getProjectService() : service);
    const routes = createProjectResolutionRoutes({ registry: { getChat: () => null }, inspect: manager.inspectProject });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const server = Bun.serve({
      hostname: '0.0.0.0', port: 0,
      async fetch(request) {
        const response = await routes['/api/v1/projects/resolve']!.GET!(request, new URL(request.url));
        handled.resolve(response.status);
        return response;
      },
    });
    const controller = new AbortController();
    try {
      const executorId = remote ? '22222222-2222-4222-8222-222222222222' : 'local';
      const url = new URL(`http://127.0.0.1:${server.port}/api/v1/projects/resolve`);
      url.search = new URLSearchParams({ executorId, projectPath: root }).toString();
      const pending = fetch(url, { signal: controller.signal }).catch((error: unknown) => error);
      await withTimeout(entered.promise, 3000, () => 'Project inspection did not start');
      controller.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      await withTimeout(cancelled.promise, 3000, () => 'Project inspection ignored cancellation');
      expect(await withTimeout(handled.promise, 3000, () => 'Route did not settle')).toBe(499);
      expect(projectService).toHaveBeenCalledWith(executorId);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      release.resolve();
      await server.stop(true);
      logged.mockRestore();
      projectService.mockRestore();
      inspect.mockRestore();
      await remote?.dispose();
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`abandoned mention lookups cancel on their original executor (${dialer} dials)`, async () => {
    const root = await mkdtemp(join(homedir(), 'mention-rpc-cancel-'));
    const manager = await ExecutorManager.create({
      id: 'local', workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const service = new ProjectService(root, options => options?.signal?.throwIfAborted());
    const mentions = spyOn(service, 'resolveFileMentions').mockImplementation(async (input, options) => {
      if (input.command === 'Read @next.txt') return 'Synthetic expanded context';
      const onAbort = () => { cancelled.resolve(); release.resolve(); };
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      entered.resolve();
      try {
        await release.promise;
        options?.signal?.throwIfAborted();
        return input.command;
      } finally {
        options?.signal?.removeEventListener('abort', onAbort);
      }
    });
    const remote = await remoteFixture(dialer, (_controller, _worker, provider) => {
      provider.executor.getProjectService = async () => service;
    }, root);
    const projectService = spyOn(manager, 'projectService').mockImplementation(() => remote.executor.getProjectService());
    const controller = new AbortController();
    try {
      const executorId = '22222222-2222-4222-8222-222222222222';
      const pending = manager.resolveFileMentions('Read @stalled.txt', root, executorId, { signal: controller.signal })
        .then(() => 'completed', () => 'cancelled');
      await withTimeout(entered.promise, 3000, () => 'Mention lookup did not start');
      controller.abort();
      expect(await withTimeout(pending, 3000, () => 'Mention lookup did not settle')).toBe('cancelled');
      await withTimeout(cancelled.promise, 3000, () => 'Worker mention lookup ignored cancellation');
      expect(await manager.resolveFileMentions('Read @next.txt', root, executorId)).toBe('Synthetic expanded context');
      expect(mentions).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      release.resolve();
      projectService.mockRestore();
      await remote.dispose();
      mentions.mockRestore();
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
