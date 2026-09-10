import type { TerminalErrorCode } from '../../common/terminal.js';
import { WorkspaceTerminalError } from '../execution-nodes/workspace-terminals.js';
import { jsonError } from '../lib/http-error.js';

const TERMINAL_ERROR_STATUS = Object.freeze({
  'terminal-not-found': 404,
  'terminal-limit': 409,
  'terminal-validation': 422,
  'terminal-takeover-required': 409,
  'terminal-not-attached': 409,
  'terminal-process-exited': 409,
  'terminal-replay-sequence': 400,
  'terminal-backpressure': 429,
  'terminal-auth-expired': 401,
  'terminal-internal': 500,
} satisfies Record<TerminalErrorCode, number>);

export function terminalErrorResponse(error: unknown): Response {
  if (error instanceof WorkspaceTerminalError && Object.hasOwn(TERMINAL_ERROR_STATUS, error.code)) {
    const status = TERMINAL_ERROR_STATUS[error.code];
    return jsonError(error.message, status, error.code, status >= 500);
  }
  return jsonError('Terminal operation failed.', 500, 'terminal-internal', true);
}
