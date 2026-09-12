import type { Issue, IssueComment, IssueErrorCode } from '../../common/issues.js';
import { ISSUE_LIMITS } from '../../common/issues.js';
import type { HttpRouteContext, ServerPrincipal } from '../lib/http-route-types.js';
import { isDomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import { IssueDomainError } from './errors.js';

export function requireIssuePrincipal(context?: HttpRouteContext): ServerPrincipal {
  if (!context?.principal) throw new IssueDomainError('ISSUE_UNAUTHORIZED', 'Sign in to use Issues.');
  return context.principal;
}

export function issueJson(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > ISSUE_LIMITS.httpBytes) {
    throw new IssueDomainError('ISSUE_RESULT_TOO_LARGE', 'Issue response exceeds the transport limit. Request less content.');
  }
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function issueErrorResponse(error: unknown): Response {
  if (isDomainError(error)) {
    const conflict = error instanceof IssueDomainError ? error : null;
    const payload: { success: false; error: string; errorCode: string; retryable: boolean;
      currentIssue?: Issue; currentComment?: IssueComment } = {
      success: false, error: error.message, errorCode: error.code, retryable: error.retryable,
      ...(conflict?.currentIssue ? { currentIssue: conflict.currentIssue } : {}),
      ...(conflict?.currentComment ? { currentComment: conflict.currentComment } : {}),
    };
    return issueJson(payload, error.status);
  }
  createLogger('issues').warn('Unexpected issue request failure.');
  return issueJson({ success: false, error: 'Issue request could not be completed.',
    errorCode: 'ISSUE_INTERNAL_ERROR' satisfies IssueErrorCode, retryable: false }, 500);
}

export async function readIssueBody(request: Request): Promise<unknown> {
  const tooLarge = () => new IssueDomainError('ISSUE_REQUEST_TOO_LARGE',
    'Encoded issue request exceeds 64 KiB. Reduce the submitted body.');
  const length = request.headers.get('content-length');
  if (length && Number(length) > ISSUE_LIMITS.requestBytes) throw tooLarge();
  if (!request.body) throw new IssueDomainError('ISSUE_VALIDATION_FAILED', 'A JSON body is required.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  let finished = false;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) { finished = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > ISSUE_LIMITS.requestBytes) throw tooLarge();
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new IssueDomainError('ISSUE_VALIDATION_FAILED', 'A valid UTF-8 JSON body is required.');
    }
    throw error;
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
