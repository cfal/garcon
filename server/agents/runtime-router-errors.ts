import {
  AgentIntegrationError,
  type AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import { DomainError } from '../lib/domain-error.js';

export function dispatchFailureDetail(error: unknown): AgentRunFailureDetail {
  if (error instanceof AgentIntegrationError) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
  }
  if (error instanceof DomainError) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
  }
  return {
    code: 'DISPATCH_FAILED',
    ...(error instanceof Error && error.message ? { message: error.message } : {}),
  };
}
