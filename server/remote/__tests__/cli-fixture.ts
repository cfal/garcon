import { ExecutorRpc } from '../transport/rpc.js';
import { SessionTransport } from '../transport/session-transport.js';
import type { ControllerCliDispatcher } from '../../controller/executors/cli-dispatcher.js';

export const CLI_EXECUTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export function cliPair(
  dispatcher: ControllerCliDispatcher,
  assertCurrent: () => void = () => {},
  onReplyAdmission: () => void = () => {},
) {
  const left = new SessionTransport(crypto.randomUUID(), 'worker', () => {}, {}, CLI_EXECUTOR_ID);
  const right = new SessionTransport(crypto.randomUUID(), 'controller', () => {}, {}, CLI_EXECUTOR_ID);
  let writable = true;
  const receiveLeft = left.attach({ send: (body) => receiveRight.receive(body), close() {}, canSend: () => writable });
  const receiveRight = right.attach({ send: (body) => receiveLeft.receive(body), close() {} });
  const controller = new ExecutorRpc(left);
  const worker = new ExecutorRpc(right);
  controller.handle(async (call, signal, guardReply) => {
    const access = { executorId: CLI_EXECUTOR_ID, rpc: controller, signal, assertCurrent };
    const observeReply: typeof guardReply = (guard) => guardReply((bytes) => {
      try { guard(bytes); }
      finally { onReplyAdmission(); }
    });
    if (call.method === 'controllerCli.describe') return dispatcher.describe(access, observeReply);
    if (call.method === 'controllerCli.request') return dispatcher.request(call.request, access, observeReply);
    throw new Error('Unexpected reverse call');
  });
  return { controller, worker, block() { writable = false; }, unblock() { writable = true; },
    close() { left.close(); right.close(); } };
}
