import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createFilesRoutes from '../../../server/controller/routes/files.js';
import { ChatRegistry } from '../../../server/controller/chats/store.js';
import { FilesService } from '../../../server/runtime/files/service.js';

test('an HTTP disconnect cancels a Local tree read without an unhandled route error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'files-http-cancel-'));
  const entered = Promise.withResolvers<void>();
  const handled = Promise.withResolvers<number>();
  const files = new FilesService({
    executorId: 'local', projectBasePath: root,
    async readDirectory(_root, _directory, signal) {
      if (!signal) throw new Error('Missing request signal');
      const cancelled = Promise.withResolvers<void>();
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      entered.resolve();
      await cancelled.promise;
      signal.throwIfAborted();
      throw new Error('Request was not cancelled');
    },
  });
  const routes = createFilesRoutes(new ChatRegistry(root), {
    files: async () => files, inspectProject: async () => { throw new Error('Tree requests do not inspect projects'); },
  });
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    async fetch(request) {
      const response = await routes['/api/v1/files/tree']!.GET!(request, new URL(request.url));
      handled.resolve(response.status);
      return response;
    },
  });
  const cancellation = new AbortController();
  try {
    const response = fetch(`http://127.0.0.1:${server.port}/api/v1/files/tree`, { signal: cancellation.signal })
      .catch((error: unknown) => error);
    await entered.promise;
    cancellation.abort();
    expect(await response).toMatchObject({ name: 'AbortError' });
    expect(await handled.promise).toBe(499);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    cancellation.abort();
    await server.stop(true);
    logged.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
