import { readBoundedJsonBody } from '../../common/bounded-json-body.js';
import { NODE_ENROLLMENT_TIMEOUT_MS } from '../../common/execution-node-config.js';
import { DomainError } from '../lib/domain-error.js';

export async function readNodeEnrollmentBody(request: Request, maxBytes: number): Promise<unknown> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(new DomainError('REQUEST_TIMEOUT', 'Node enrollment body timed out', 408)),
    NODE_ENROLLMENT_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  try {
    return await readBoundedJsonBody(request, maxBytes, signal);
  } catch {
    signal.throwIfAborted();
    throw new DomainError('NODE_ENROLLMENT_INVALID', 'Node enrollment requires bounded UTF-8 JSON', 400);
  } finally {
    clearTimeout(timeout);
  }
}
