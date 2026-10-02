import { randomBytes } from 'node:crypto';
import { version } from '../../../package.json';
import { EXECUTOR_PROTOCOL_REVISION } from '../transport/rpc-protocol.js';
import type { LinkHello, LinkRole } from '../transport/link-handshake.js';

export function primaryHello(role: LinkRole): LinkHello {
  return {
    type: 'hello', version: `${version}+protocol.${EXECUTOR_PROTOCOL_REVISION}`, role,
    executorId: role === 'controller' ? 'synthetic-executor' : null,
    runtimeId: crypto.randomUUID(), nonce: randomBytes(32).toString('hex'),
    lane: 'primary', sessionId: role === 'controller' ? crypto.randomUUID() : null, primarySessionId: null,
  };
}
