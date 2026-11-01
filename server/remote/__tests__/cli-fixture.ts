import { WorkerSessionTransport, handleTestRpc, testControllerContracts, testSessionProtocol } from './test-session-transport.js';
import { protocolProfileId } from '../transport/protocol-compatibility.js';
import { intersectContracts } from '@garcon/common/protocol-contracts';
import { ExecutorRpc } from '../transport/rpc.js';
import { TestSessionTransport as SessionTransport } from './test-session-transport.js';
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
  const contracts = testControllerContracts(dispatcher.contracts.entries);
  const workerProtocol = testSessionProtocol(CLI_EXECUTOR_ID, 'worker');
  const profile = { bootstrap: 1, contracts: intersectContracts(contracts.offer.contracts, workerProtocol.profile.contracts) };
  const continuity = { ...workerProtocol.continuity, profileId: protocolProfileId(profile) };
  const controllerAdmission = new RpcAdmissionBudgets();
  const workerAdmission = new RpcAdmissionBudgets();
  let writable = true;
  const pair = (lane: RpcLane) => {
    const id = lane === 'primary' ? parent : crypto.randomUUID();
    const left = new SessionTransport(id, 'worker', () => {}, {}, CLI_EXECUTOR_ID, lane, parent, { contracts, profile, continuity });
    const right = new WorkerSessionTransport(id, 'controller', () => {}, {}, CLI_EXECUTOR_ID, lane, parent,
      { ...workerProtocol, profile, continuity });
    const receiveLeft = left.attach({ send: (body) => receiveRight.receive(body), close() {}, canSend: () => lane === 'primary' || writable });
    const receiveRight = right.attach({ send: (body) => receiveLeft.receive(body), close() {} });
    const controller = new ExecutorRpc(left, { admission: controllerAdmission });
    const worker = new ExecutorRpc(right, { admission: workerAdmission });
    controller.activate(); worker.activate();
    handleTestRpc(controller, async (call, signal, guardReply, _undelivered, capture) => {
      const access = { executorId: CLI_EXECUTOR_ID, rpc: controller, signal, assertCurrent, assertManagement };
      const observeReply: typeof guardReply = (guard) => guardReply((bytes) => {
        try { guard(bytes); }
        finally { onReplyAdmission(); }
      });
      if (call.method === 'controllerCli.describe') return dispatcher.describe(access, observeReply);
      if (call.method === 'controllerCli.request' && capture.policy.cli) return dispatcher.request(capture.policy.cli, access, observeReply);
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
