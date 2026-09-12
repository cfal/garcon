import type { NodeSessionIdentity } from '../../../common/node-operation.js';
import { parsePrivateNodeJson } from '../../execution-nodes/transport/private-json.js';
import { parseNodeWorkerBulkText, type NodeWorkerBulkFrame } from './bulk-protocol.js';
import { parseNodeWorkerExecutionText, type NodeWorkerExecutionFrame } from './execution-protocol.js';
import { parseNodeWorkerOutputDeliveryText, type NodeWorkerOutputDeliveryChunk } from './output-delivery-protocol.js';
import { parseNodeWorkerOutputText, type NodeWorkerOutputChunk } from './output-protocol.js';
import { parseNodeWorkerOutputRetirementText, type NodeWorkerOutputRetirement } from './output-retirement.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES } from './protocol.js';
import { parseNodeWorkerServiceText, parseNodeWorkerOutputAcknowledgementText, type NodeWorkerServiceFrame, type NodeWorkerOutputAcknowledgement } from './service-protocol.js';
import { parseNodeWorkerOutputSuspensionText, type NodeWorkerOutputSuspension } from './service-protocol.js';

export type NodeWorkerApplicationFrame = NodeWorkerExecutionFrame | NodeWorkerBulkFrame | NodeWorkerOutputDeliveryChunk
  | NodeWorkerOutputChunk | NodeWorkerOutputRetirement | NodeWorkerServiceFrame | NodeWorkerOutputAcknowledgement | NodeWorkerOutputSuspension;

export function parseNodeWorkerApplicationText(text: string): NodeWorkerApplicationFrame | null {
  const value = parsePrivateNodeJson(text, MAX_NODE_WORKER_LIFECYCLE_BYTES);
  switch (value?.type) {
    case 'node-worker-execution': return parseNodeWorkerExecutionText(text);
    case 'node-worker-bulk': return parseNodeWorkerBulkText(text);
    case 'node-worker-output': return parseNodeWorkerOutputText(text);
    case 'node-worker-output-delivery': return parseNodeWorkerOutputDeliveryText(text);
    case 'node-worker-output-retired': return parseNodeWorkerOutputRetirementText(text);
    case 'node-worker-output-ack': return parseNodeWorkerOutputAcknowledgementText(text);
    case 'node-worker-output-suspended': return parseNodeWorkerOutputSuspensionText(text);
    case 'node-worker-service-request': case 'node-worker-service-result': case 'node-worker-service-cancel': return parseNodeWorkerServiceText(text);
    default: return null;
  }
}

export function nodeWorkerApplicationSession(frame: NodeWorkerApplicationFrame): NodeSessionIdentity {
  return 'session' in frame ? frame.session : 'stream' in frame ? frame.stream : frame.ack.stream;
}
