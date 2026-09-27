import type { ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import { RemoteExecutorClient } from '../client/executor-client.js';
import { serveExecutionRuntime } from '../server/executor-rpc-server.js';
import { ExecutorRpc } from '../transport/rpc.js';
import { WebSocketLink } from '../transport/websocket-link.js';

export async function connectRemoteExecutor(link: WebSocketLink, setupRpc: (rpc: ExecutorRpc) => void = () => {}) {
  if (!link.executorId) throw new Error('A controller link is required');
  const ready = Promise.withResolvers<void>();
  const executor = new RemoteExecutorClient(link.executorId, link, setupRpc);
  const unsubscribe = executor.onAvailabilityChanged(value => {
    if (value === 'ready') ready.resolve();
    if (value === 'disposed') ready.reject(new Error('Executor disposed before readiness'));
  });
  void link.ready.catch(ready.reject);
  const timeout = setTimeout(() => ready.reject(new Error('Executor did not become ready')), 5_000);
  try {
    await ready.promise;
    return executor;
  } catch (error) {
    await executor.dispose();
    throw error;
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
}

export type RuntimeBackend = 'local' | 'controller' | 'worker';
export const RUNTIME_BACKENDS = ['local', 'controller', 'worker'] as const;

export async function runtimeAdapter(runtime: ExecutionRuntimeApi, backend: RuntimeBackend) {
  if (backend === 'local') return { executor: runtime, dispose: async () => {} };
  const info = await runtime.getInfo();
  const options = { executorId: info.executorId, secret: Buffer.alloc(32, 42).toString('base64url'), allowInsecureDevelopment: true };
  const controller = new WebSocketLink({ ...options, role: 'controller' });
  const worker = new WebSocketLink({ ...options, role: 'worker' });
  const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
  worker.onSession(transport => scopes.push(serveExecutionRuntime(runtime, new ExecutorRpc(transport))));
  const connected = connectRemoteExecutor(controller);
  if (backend === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const dispose = async () => {
    await controller.dispose();
    await worker.dispose();
    for (const scope of scopes) await scope.dispose();
  };
  try { return { executor: await connected, dispose }; }
  catch (error) { await dispose(); throw error; }
}
