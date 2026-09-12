import { controllerTlsOptions } from '../../common/controller-tls.js';
import { verifyControllerTlsTrust } from '../../common/controller-tls-node.js';
import { parseExecutionNodePairing, type ExecutionNodePairing } from '../../common/execution-node-config.js';
import { createNodeClientSocket, type NodeClientSocket } from '../execution-nodes/transport/bun-sockets.js';
import { NODE_BULK_CHANNEL_PATH, NODE_SESSION_CHANNEL_PATH } from '../execution-nodes/transport/channel-path.js';

/** Opens only the paired controller origin with connection-scoped certificate verification. */
export function createNodeControllerSocket(pairing: ExecutionNodePairing): NodeClientSocket {
  return connect(pairing, NODE_SESSION_CHANNEL_PATH);
}

export function createNodeBulkSocket(pairing: ExecutionNodePairing): NodeClientSocket {
  return connect(pairing, NODE_BULK_CHANNEL_PATH);
}

function connect(pairing: ExecutionNodePairing, pathname: typeof NODE_SESSION_CHANNEL_PATH | typeof NODE_BULK_CHANNEL_PATH): NodeClientSocket {
  const captured = parseExecutionNodePairing(pairing);
  if (!captured) throw new TypeError('Invalid execution node pairing');
  const trust = verifyControllerTlsTrust(captured.trust);
  const url = new URL(captured.controllerUrl);
  url.protocol = 'wss:';
  url.pathname = pathname;
  return createNodeClientSocket(url, { tls: controllerTlsOptions(trust), perMessageDeflate: false,
    headers: { Authorization: `Garcon-Node ${captured.credential}` } });
}
