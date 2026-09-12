import { MAX_NODE_WORKER_LIFECYCLE_BYTES } from './protocol.js';

export const NODE_WORKER_EXECUTION_LIMITS = Object.freeze({ maxRequests: 32, reservedControlRequests: 8 });
export const NODE_WORKER_SERVICE_LIMITS = Object.freeze({
  maxRequests: 16, maxProviderRequests: 4, reservedProviderStatusRequests: 1, providerRequestTimeoutMs: 60_000,
});

const RESERVED_CONTROL_FRAMES = 4;
const RESERVED_URGENT_FRAMES = 8;

export const NODE_WORKER_WRITER_LIMITS = Object.freeze({
  maxFrameBytes: MAX_NODE_WORKER_LIFECYCLE_BYTES,
  maxQueuedBytes: 2 * MAX_NODE_WORKER_LIFECYCLE_BYTES,
  // The frame budget covers request/reply bursts plus cancellations; the byte cap may refuse larger payloads first.
  maxQueuedFrames: 2 * (NODE_WORKER_EXECUTION_LIMITS.maxRequests + NODE_WORKER_EXECUTION_LIMITS.reservedControlRequests
    + NODE_WORKER_SERVICE_LIMITS.maxRequests) + RESERVED_CONTROL_FRAMES + RESERVED_URGENT_FRAMES,
  reservedControlBytes: 4096,
  reservedControlFrames: RESERVED_CONTROL_FRAMES,
  reservedUrgentBytes: 64 * 1024,
  reservedUrgentFrames: RESERVED_URGENT_FRAMES,
  writeTimeoutMs: 5000,
});
