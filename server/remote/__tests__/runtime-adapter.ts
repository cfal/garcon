import type { ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import { RemoteExecutorClient, type RemoteExecutorClientOptions } from '../client/executor-client.js';
import { serveExecutionRuntime } from '../server/executor-rpc-server.js';
import { ProducerRelay } from '../server/producer-relay.js';
import { RpcReplyJournal } from '../transport/rpc-journal.js';
import { ExecutorRpc } from '../transport/rpc.js';
import { ExecutorRpcConnection } from '../transport/rpc-connection.js';
import { RpcAdmissionBudgets } from '../transport/rpc-admission.js';
import type { SessionTransport } from '../transport/session-transport.js';
import { WebSocketLink } from '../transport/websocket-link.js';

export async function connectRemoteExecutor(
  link: WebSocketLink,
  setupRpc: (rpc: ExecutorRpc) => void = () => {},
  options: RemoteExecutorClientOptions = {},
) {
  if (!link.executorId) throw new Error('A controller link is required');
  const ready = Promise.withResolvers<void>();
  const executor = new RemoteExecutorClient(link.executorId, link, setupRpc, undefined, null, options);
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

const workerBudgets = new WeakMap<WebSocketLink, RpcAdmissionBudgets>();

export function servePairedRuntime(link: WebSocketLink, transport: SessionTransport, runtime: ExecutionRuntimeApi, relay: ProducerRelay, journal?: RpcReplyJournal) {
  let admission = workerBudgets.get(link);
  if (!admission) { admission = new RpcAdmissionBudgets(); workerBudgets.set(link, admission); }
  const connection = new ExecutorRpcConnection(link, transport, { journal, admission });
  const serving = serveExecutionRuntime(runtime, connection.primary, relay);
  connection.onEndpoint((rpc) => { if (rpc !== connection.primary) serving.attachBulk(rpc); });
  return { ...serving, connection };
}

export async function runtimeAdapter(runtime: ExecutionRuntimeApi, backend: RuntimeBackend) {
  if (backend === 'local') return { executor: runtime, dispose: async () => {} };
  const info = await runtime.getInfo();
  const options = { executorId: info.executorId, secret: Buffer.alloc(32, 42).toString('base64url'), noTls: true };
  const controller = new WebSocketLink({ ...options, role: 'controller' });
  const worker = new WebSocketLink({ ...options, role: 'worker' });
  const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
  const relay = new ProducerRelay();
  const journal = new RpcReplyJournal();
  worker.onSession(transport => scopes.push(servePairedRuntime(worker, transport, runtime, relay, journal)));
  const connected = connectRemoteExecutor(controller);
  if (backend === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const dispose = async () => {
    await controller.dispose();
    await worker.dispose();
    for (const scope of scopes) await scope.dispose();
    relay.dispose();
    journal.dispose();
  };
  try { return { executor: await connected, dispose }; }
  catch (error) { await dispose(); throw error; }
}
