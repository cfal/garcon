import { NodeWorkerTransportError } from './framing.js';
import type { NodeWorkerOutputRetirement } from './output-retirement.js';
import type { NodeWorkerServiceClient } from './service-channel.js';
import type { NodeWorkerServiceResult } from './service-protocol.js';
import type { NodeDeadline } from '../../execution-nodes/deadline.js';

/** Preserves refusal or uncertainty without authorizing a successor. */
export class NodeOutputRetirementUnconfirmedError extends Error {
  constructor(readonly result: Extract<NodeWorkerServiceResult, { kind: 'rejected' | 'unknown' }>) {
    super('Node output retirement is unconfirmed');
    this.name = 'NodeOutputRetirementUnconfirmedError';
  }
}

export async function confirmNodeOutputRetirement(
  service: Pick<NodeWorkerServiceClient, 'call'>,
  target: Pick<NodeWorkerOutputRetirement, 'instanceId' | 'stream'>,
  signal: AbortSignal,
  deadline?: NodeDeadline,
): Promise<void> {
  const result = await service.call({ method: 'retire-output', instanceId: target.instanceId, stream: target.stream }, signal, deadline);
  signal.throwIfAborted();
  if (result.kind === 'output-fenced') return;
  if (result.kind === 'rejected' || result.kind === 'unknown') throw new NodeOutputRetirementUnconfirmedError(result);
  throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
}
