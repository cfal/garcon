import { SessionTransport } from '../transport/session-transport.js';
import { protocolProfileId, type SessionProtocol } from '../transport/protocol-compatibility.js';
import type { MessageSessionOptions } from '../transport/message-session.js';
import type { RpcLane } from '../transport/rpc-lane.js';

export function testSessionProtocol(executorId = 'local'): SessionProtocol {
  const profile = Object.freeze({ core: 1, contracts: Object.freeze({}) });
  return Object.freeze({ profile, continuity: Object.freeze({ executorId,
    controllerRuntimeId: 'synthetic-controller', workerRuntimeId: 'synthetic-worker', profileId: protocolProfileId(profile) }) });
}

export class TestSessionTransport extends SessionTransport {
  constructor(id: string, peerRuntimeId: string, retired: (error: Error) => void,
    limits: Pick<MessageSessionOptions, 'maxQueuedBytes' | 'maxQueuedFrames' | 'budget'> = {},
    executorId = 'local', lane: RpcLane = 'primary', primarySessionId = id,
    protocol = testSessionProtocol(executorId)) {
    super(id, peerRuntimeId, protocol, retired, limits, executorId, lane, primarySessionId);
  }
}
