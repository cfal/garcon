import { ExecutorRpc } from '../transport/rpc.js';
import { SessionTransport } from '../transport/session-transport.js';
import type { ControllerCliDispatcher } from '../../controller/executors/cli-dispatcher.js';
import type { ExecutorRpcConnection } from '../transport/rpc-connection.js';
import { RpcAdmissionBudgets } from '../transport/rpc-admission.js';
import type { RpcLane } from '../transport/rpc-lane.js';

export const CLI_EXECUTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export function cliPair(
  dispatcher: ControllerCliDispatcher,
  assertCurrent: () => void = () => {},
  onReplyAdmission: () => void = () => {},
  assertManagement: () => void = () => {},
) {
  const parent = crypto.randomUUID();
  const controllerAdmission = new RpcAdmissionBudgets();
  const workerAdmission = new RpcAdmissionBudgets();
  let writable = true;
  const pair = (lane: RpcLane) => {
    const id = lane === 'primary' ? parent : crypto.randomUUID();
    const left = new SessionTransport(id, 'worker', () => {}, {}, CLI_EXECUTOR_ID, lane, parent);
    const right = new SessionTransport(id, 'controller', () => {}, {}, CLI_EXECUTOR_ID, lane, parent);
    const receiveLeft = left.attach({ send: (body) => receiveRight.receive(body), close() {}, canSend: () => lane === 'primary' || writable });
    const receiveRight = right.attach({ send: (body) => receiveLeft.receive(body), close() {} });
    const controller = new ExecutorRpc(left, { admission: controllerAdmission });
    const worker = new ExecutorRpc(right, { admission: workerAdmission });
    controller.activate(); worker.activate();
    controller.handle(async (call, signal, guardReply) => {
      const access = { executorId: CLI_EXECUTOR_ID, rpc: controller, signal, assertCurrent, assertManagement };
      const observeReply: typeof guardReply = (guard) => guardReply((bytes) => {
        try { guard(bytes); }
        finally { onReplyAdmission(); }
      });
      if (call.method === 'controllerCli.describe') return dispatcher.describe(access, observeReply);
      if (call.method === 'controllerCli.request') return dispatcher.request(call.request, access, observeReply);
      throw new Error('Unexpected reverse call');
    });
    return { controller, worker, close() { left.close(); right.close(); } };
  };
  const primary = pair('primary');
  const bulk = pair('bulk');
  const connection = {
    primary: primary.worker,
    async acquire(lane, options) { return { rpc: lane === 'primary' ? primary.worker : bulk.worker, timeoutMs: options.timeoutMs }; },
  } satisfies Pick<ExecutorRpcConnection, 'primary' | 'acquire'>;
  return { ...bulk, primary, connection, block() { writable = false; }, unblock() { writable = true; },
    close() { primary.close(); bulk.close(); } };
}
