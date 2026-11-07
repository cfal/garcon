import { WORKFLOW_REQUEST_BYTES } from '../../../common/workflow-http.js';
import { WORKFLOW_LIMITS } from '../../../common/workflows.js';
import { DomainError } from '../../common/domain-error.js';
import { isCurrentBrowserPrincipal } from '../auth/token.js';
import type { HttpRouteContext } from '../lib/http-route-types.js';
import type { WorkflowAuthority } from './contracts.js';

export function workflowAuthority(context: HttpRouteContext | undefined): WorkflowAuthority {
  const principal = context?.principal;
  if (!principal) throw new DomainError('WORKFLOW_UNAUTHORIZED', 'Sign in to use Workflows.', 401);
  const assertCurrent = () => {
    context?.assertCurrent?.();
    if (principal.mode === 'executor' && !context?.assertCurrent
      || principal.mode === 'authenticated' && (principal.expiresAtMs <= Date.now() || !isCurrentBrowserPrincipal(principal))) {
      throw new DomainError('WORKFLOW_FORBIDDEN', 'Workflow authority is no longer current.', 403);
    }
  };
  assertCurrent();
  return { key: JSON.stringify([principal.mode, principal.key]), browserSession: principal.mode === 'authenticated', assertCurrent };
}

export function workflowJson(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > WORKFLOW_LIMITS.pageBytes) {
    throw new DomainError('WORKFLOW_RESULT_TOO_LARGE', 'Workflow response exceeds the page limit. Request a smaller page.', 413);
  }
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export async function readWorkflowBody(request: Request): Promise<unknown> {
  const invalid = () => new DomainError('WORKFLOW_INVALID_REQUEST', 'A valid UTF-8 JSON body is required.', 400);
  const oversized = () => new DomainError('WORKFLOW_REQUEST_TOO_LARGE', 'Workflow request exceeds the encoded size limit.', 413);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) throw invalid();
  const length = request.headers.get('content-length');
  if (length && Number(length) > WORKFLOW_REQUEST_BYTES) throw oversized();
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  let finished = false;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) { finished = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > WORKFLOW_REQUEST_BYTES) throw oversized();
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw invalid();
    throw error;
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
