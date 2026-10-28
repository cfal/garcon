import { AgentCallError, AgentIntegrationError, type AgentIntegrationErrorCode, type AgentDeliveryOutcome } from "@garcon/server-agent-interface";
import type { JsonObject } from "@garcon/common/json";
import type { ErrorCode } from "../../../common/error-codes.js";
import { DomainError } from "../../common/domain-error.js";
import { TerminalError } from "../../../common/terminal-error.js";
import { GitServiceError, type GitServiceErrorCode } from "../../../common/git-error.js";
import type { TerminalErrorCode } from "../../../common/terminal.js";
import { MALFORMED_DATA } from "./failure-reason.js";
import frozenErrors from "./rpc-errors-v1.json";

export interface Failure {
  readonly code: AgentIntegrationErrorCode | ErrorCode | TerminalErrorCode | GitServiceErrorCode;
  readonly domain?: 'executor' | 'terminal' | 'git';
  readonly status?: number;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
  readonly outcome?: AgentDeliveryOutcome;
}


export function encodeFailure(error: unknown): Failure {
  if (error instanceof GitServiceError) return { domain: 'git', code: error.code, message: error.message, status: error.status, retryable: false };
  if (error instanceof TerminalError) return { domain: 'terminal', code: error.code, message: error.message, status: error.status, retryable: error.status >= 500 };
  if (error instanceof DomainError) return { domain: 'executor', code: error.code, message: error.message, status: error.status, retryable: error.retryable };
  if (error instanceof AgentIntegrationError) return {
    code: error.code, message: error.message, retryable: error.retryable,
    ...(error.details ? { details: error.details } : {}),
    ...(error instanceof AgentCallError ? { outcome: error.outcome } : {}),
  };
  // A parse error's message can echo the payload it failed on, so an error reply does not carry it.
  const message = error instanceof SyntaxError ? MALFORMED_DATA : error instanceof Error ? error.message : 'Provider operation failed';
  return { code: 'PROVIDER_FAILURE', message, retryable: false };
}

export function decodeFailure(error: Failure): Error {
  assertFailureEnvelope(error);
  if (error.domain === 'executor') {
    if (!frozenErrors.executor.includes(error.code) || !Number.isInteger(error.status) || error.status! < 400 || error.status! > 599) throw new Error('Invalid executor RPC error');
    return new DomainError(error.code as ErrorCode, error.message, error.status, error.retryable);
  }
  if (error.domain === 'git') {
    if (!frozenErrors.git.includes(error.code)) throw new Error('Invalid Git RPC error');
    return new GitServiceError(error.code as GitServiceErrorCode, error.message);
  }
  if (error.domain === 'terminal') {
    if (!frozenErrors.terminal.includes(error.code)
      || !Number.isInteger(error.status) || error.status! < 400 || error.status! > 599) throw new Error('Invalid terminal RPC error');
    return new TerminalError(error.code as TerminalErrorCode, error.message, error.status);
  }
  if (error.domain !== undefined || !frozenErrors.provider.includes(error.code)) throw new Error('Invalid provider RPC error');
  return error.outcome
    ? new AgentCallError(error.outcome, error.message, error.code as AgentIntegrationErrorCode)
    : new AgentIntegrationError(error.code as AgentIntegrationErrorCode, error.message, error.retryable, error.details);
}

export function assertFailureEnvelope(error: Failure): void {
  if (!error || typeof error.message !== 'string' || typeof error.code !== 'string'
    || typeof error.retryable !== 'boolean'
    || (error.domain !== undefined && !['executor', 'terminal', 'git'].includes(error.domain))
    || (error.outcome !== undefined && !['unknown', 'not-dispatched', 'rejected'].includes(error.outcome))) {
    throw new Error('Invalid RPC error');
  }
}

// Domain result validators own their mutation-safe projection; other decode failures cannot prove an outcome.
export function resultFailure(error: unknown): Error {
  return error instanceof Error && encodeFailure(error).domain ? error
    : new AgentCallError('unknown', "The executor's reply could not be read, so the outcome is unknown.");
}
