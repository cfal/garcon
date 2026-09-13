import { NODE_WIRE_VERSION, parseProducerStreamIdentity, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { exactNodeFields, parsePrivateNodeJson } from '../../execution-nodes/transport/private-json.js';

export interface NodeWorkerOutputRetirement {
  readonly type: 'node-worker-output-retired';
  readonly reason: 'output-retired' | 'replay-gap';
  readonly version: typeof NODE_WIRE_VERSION;
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
}

export function parseNodeWorkerOutputRetirementText(text: string): NodeWorkerOutputRetirement | null {
  const value = parsePrivateNodeJson(text, 4096);
  if (!exactNodeFields(value, ['type', 'reason', 'version', 'instanceId', 'stream']) || value.type !== 'node-worker-output-retired'
    || value.version !== NODE_WIRE_VERSION || !isExecutionIdentity(value.instanceId)
    || value.reason !== 'output-retired' && value.reason !== 'replay-gap') return null;
  const stream = parseProducerStreamIdentity(value.stream);
  return stream ? { type: value.type, reason: value.reason, version: NODE_WIRE_VERSION, instanceId: value.instanceId, stream } : null;
}

export function serializeNodeWorkerOutputRetirement(frame: NodeWorkerOutputRetirement): string {
  const text = JSON.stringify(frame);
  if (!parseNodeWorkerOutputRetirementText(text)) throw new TypeError('Invalid worker output retirement');
  return text;
}
