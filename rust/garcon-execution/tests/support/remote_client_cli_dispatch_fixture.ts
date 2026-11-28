import { ControllerCliDispatcher } from '../../../../server/controller/executors/cli-dispatcher.ts';
import { CLI_EXECUTOR_ID, cliPair } from '../../../../server/remote/__tests__/cli-fixture.ts';
import type { RpcLane } from '../../../../server/remote/transport/rpc-lane.ts';

export function acceptsLane(value: unknown): value is RpcLane { return value === 'primary' || value === 'bulk'; }
export function acceptsBody(value: unknown): value is string { return typeof value === 'string'; }
export function acceptsHeader(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && /^[!-~]*$/.test(value);
}

export async function dispatchCli(value: unknown, lane: RpcLane, rawBody: string, retryAfter: string | null) {
  const respond = () => new Response(rawBody, { status: 409, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } });
  const dispatcher = new ControllerCliDispatcher({ serverInstanceId: 'controller', workspaceName: null,
    isShuttingDown: () => false, routes: {
      '/api/v1/chats': { GET: respond }, '/api/v1/chats/run': { POST: respond },
      '/api/v1/chats/turn-receipt': { GET: respond }, '/api/v1/chats/stop': { POST: respond },
    } });
  const pair = cliPair(dispatcher);
  try {
    return await dispatcher.request(value, { executorId: CLI_EXECUTOR_ID, rpc: lane === 'primary' ? pair.primary.controller : pair.controller,
      signal: new AbortController().signal, assertCurrent() {}, assertManagement() {} }, () => {});
  } finally {
    pair.close();
  }
}
