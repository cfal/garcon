import {
  AgentCallError,
  AgentIntegrationError,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import { DomainError } from '../../common/domain-error.js';
import { isErrorCode, type ErrorCode } from '../../../common/error-codes.js';

// A failure before provider dispatch cannot have run anything.
export function executionSetupFailure(error: unknown): unknown {
  return error instanceof AgentCallError && error.outcome === 'unknown'
    ? new AgentCallError('not-dispatched', `The turn did not start: ${error.message}`)
    : error;
}

// A remote launch whose reply was lost with its executor session.
export function isLostLaunchReply(error: unknown): error is AgentCallError {
  return error instanceof AgentCallError && error.outcome === 'unknown';
}

export function dispatchFailureDetail(error: unknown): AgentRunFailureDetail {
  if (error instanceof AgentIntegrationError || error instanceof DomainError) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
  }
  return {
    code: 'DISPATCH_FAILED',
    ...(error instanceof Error && error.message ? { message: error.message } : {}),
  };
}

export function publicDispatchFailure(error: unknown): { error: string; errorCode: ErrorCode } {
  const { code } = dispatchFailureDetail(error);
  return {
    error: error instanceof Error ? error.message : String(error),
    errorCode: isErrorCode(code) ? code : 'INTERNAL_ERROR',
  };
}
