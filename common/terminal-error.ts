import type { TerminalErrorCode } from './terminal.js';

export class TerminalError extends Error {
  constructor(readonly code: TerminalErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = 'TerminalError';
  }
}
