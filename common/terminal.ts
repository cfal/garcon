export const TERMINAL_SESSION_LIMIT = 8;
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024;

export type TerminalProcessStatus = 'running' | 'exited';
export type TerminalServerAttachmentStatus = 'attached' | 'detached';

export interface TerminalMetadata {
  terminalId: string;
  displaySequence: number;
  initialWorkingDirectory: string;
  processStatus: TerminalProcessStatus;
  attachmentStatus: TerminalServerAttachmentStatus;
  createdAt: string;
  exitCode: number | null;
  latestOutputSequence: number;
}

export interface TerminalOutputChunk {
  sequence: number;
  data: string;
}

export interface TerminalCreateRequest {
  requestId: string;
  requestedInitialWorkingDirectory: string | null;
}

export interface TerminalTerminateRequest {
  terminalId: string;
  requestId: string;
}

export interface TerminalListResponse {
  success: true;
  terminals: TerminalMetadata[];
}

export interface TerminalCreateResponse {
  success: true;
  terminal: TerminalMetadata;
}

export interface TerminalTerminateResponse {
  success: true;
  terminalId: string;
  terminal: TerminalMetadata | null;
}

export type TerminalErrorCode =
  | 'terminal-not-found'
  | 'terminal-limit'
  | 'terminal-validation'
  | 'terminal-takeover-required'
  | 'terminal-not-attached'
  | 'terminal-process-exited'
  | 'terminal-replay-sequence'
  | 'terminal-backpressure'
  | 'terminal-auth-expired'
  | 'terminal-stream-capacity'
  | 'terminal-internal';

const TERMINAL_ERROR_CODES: ReadonlySet<TerminalErrorCode> = new Set([
  'terminal-not-found',
  'terminal-limit',
  'terminal-validation',
  'terminal-takeover-required',
  'terminal-not-attached',
  'terminal-process-exited',
  'terminal-replay-sequence',
  'terminal-backpressure',
  'terminal-auth-expired',
  'terminal-stream-capacity',
  'terminal-internal',
]);

export type TerminalStreamClientMessage =
  | {
      type: 'terminal-attach';
      terminalId: string;
      clientId: string;
      afterSequence: number;
      intent: 'restore' | 'takeover';
    }
  | { type: 'terminal-input'; terminalId: string; data: string }
  | { type: 'terminal-resize'; terminalId: string; cols: number; rows: number };

export type TerminalStreamServerMessage =
  | {
      type: 'terminal-attached';
      terminal: TerminalMetadata;
      replay: TerminalOutputChunk[];
    }
  | {
      type: 'terminal-output';
      terminalId: string;
      sequence: number;
      data: string;
    }
  | { type: 'terminal-status'; terminal: TerminalMetadata }
  | {
      type: 'terminal-taken-over';
      terminalId: string;
      replacementClientId: string;
    }
  | {
      type: 'terminal-replay-truncated';
      terminalId: string;
      firstSequence: number;
    }
  | {
      type: 'terminal-error';
      terminalId?: string;
      code: TerminalErrorCode;
      message: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseTerminalCreateRequest(
  value: unknown,
): TerminalCreateRequest | null {
  const input = record(value);
  if (!input) return null;
  const requestId = nonEmptyString(input.requestId);
  if (!requestId) return null;
  if (
    input.requestedInitialWorkingDirectory !== null &&
    typeof input.requestedInitialWorkingDirectory !== 'string'
  )
    return null;
  return {
    requestId,
    requestedInitialWorkingDirectory: input.requestedInitialWorkingDirectory as
      string | null,
  };
}

export function parseTerminalTerminateRequest(
  value: unknown,
): TerminalTerminateRequest | null {
  const input = record(value);
  if (!input) return null;
  const terminalId = nonEmptyString(input.terminalId);
  const requestId = nonEmptyString(input.requestId);
  return terminalId && requestId ? { terminalId, requestId } : null;
}

export function parseTerminalStreamClientMessage(
  value: unknown,
): TerminalStreamClientMessage | null {
  const input = record(value);
  if (!input) return null;
  const terminalId = nonEmptyString(input.terminalId);
  if (!terminalId) return null;
  if (input.type === 'terminal-attach') {
    const clientId = nonEmptyString(input.clientId);
    const afterSequence = nonNegativeInteger(input.afterSequence);
    if (!clientId || afterSequence === null) return null;
    if (input.intent !== 'restore' && input.intent !== 'takeover') return null;
    return {
      type: 'terminal-attach',
      terminalId,
      clientId,
      afterSequence,
      intent: input.intent,
    };
  }
  if (input.type === 'terminal-input' && typeof input.data === 'string') {
    if (utf8ByteLength(input.data) > TERMINAL_MAX_INPUT_BYTES) return null;
    return { type: 'terminal-input', terminalId, data: input.data };
  }
  if (input.type === 'terminal-resize') {
    const cols = positiveInteger(input.cols);
    const rows = positiveInteger(input.rows);
    return cols && rows
      ? { type: 'terminal-resize', terminalId, cols, rows }
      : null;
  }
  return null;
}

export function parseTerminalMetadata(value: unknown): TerminalMetadata | null {
  const input = record(value);
  if (!input) return null;
  const terminalId = nonEmptyString(input.terminalId);
  const displaySequence = positiveInteger(input.displaySequence);
  const latestOutputSequence = nonNegativeInteger(input.latestOutputSequence);
  if (!terminalId || !displaySequence || latestOutputSequence === null)
    return null;
  if (
    typeof input.initialWorkingDirectory !== 'string' ||
    typeof input.createdAt !== 'string'
  )
    return null;
  if (input.processStatus !== 'running' && input.processStatus !== 'exited')
    return null;
  if (
    input.attachmentStatus !== 'attached' &&
    input.attachmentStatus !== 'detached'
  )
    return null;
  if (input.exitCode !== null && typeof input.exitCode !== 'number')
    return null;
  return {
    terminalId,
    displaySequence,
    initialWorkingDirectory: input.initialWorkingDirectory,
    processStatus: input.processStatus,
    attachmentStatus: input.attachmentStatus,
    createdAt: input.createdAt,
    exitCode: input.exitCode as number | null,
    latestOutputSequence,
  };
}

export function parseTerminalStreamServerMessage(
  value: unknown,
): TerminalStreamServerMessage | null {
  const input = record(value);
  if (!input || typeof input.type !== 'string') return null;
  if (input.type === 'terminal-attached') {
    const terminal = parseTerminalMetadata(input.terminal);
    if (!terminal || !Array.isArray(input.replay)) return null;
    const replay: TerminalOutputChunk[] = [];
    for (const value of input.replay) {
      const chunk = record(value);
      const sequence = chunk ? positiveInteger(chunk.sequence) : null;
      if (!chunk || !sequence || typeof chunk.data !== 'string') return null;
      replay.push({ sequence, data: chunk.data });
    }
    return { type: input.type, terminal, replay };
  }
  if (input.type === 'terminal-output') {
    const terminalId = nonEmptyString(input.terminalId);
    const sequence = positiveInteger(input.sequence);
    return terminalId && sequence && typeof input.data === 'string'
      ? { type: input.type, terminalId, sequence, data: input.data }
      : null;
  }
  if (input.type === 'terminal-status') {
    const terminal = parseTerminalMetadata(input.terminal);
    return terminal ? { type: input.type, terminal } : null;
  }
  if (input.type === 'terminal-taken-over') {
    const terminalId = nonEmptyString(input.terminalId);
    const replacementClientId = nonEmptyString(input.replacementClientId);
    return terminalId && replacementClientId
      ? { type: input.type, terminalId, replacementClientId }
      : null;
  }
  if (input.type === 'terminal-replay-truncated') {
    const terminalId = nonEmptyString(input.terminalId);
    const firstSequence = positiveInteger(input.firstSequence);
    return terminalId && firstSequence
      ? { type: input.type, terminalId, firstSequence }
      : null;
  }
  if (input.type === 'terminal-error') {
    const terminalId =
      input.terminalId === undefined
        ? undefined
        : nonEmptyString(input.terminalId);
    const parsedCode = nonEmptyString(input.code);
    const code =
      parsedCode && TERMINAL_ERROR_CODES.has(parsedCode as TerminalErrorCode)
        ? (parsedCode as TerminalErrorCode)
        : null;
    if (
      (input.terminalId !== undefined && !terminalId) ||
      !code ||
      typeof input.message !== 'string'
    )
      return null;
    return {
      type: input.type,
      ...(terminalId ? { terminalId } : {}),
      code,
      message: input.message,
    };
  }
  return null;
}

export function parseTerminalListResponse(
  value: unknown,
): TerminalListResponse | null {
  const input = record(value);
  if (!input || input.success !== true || !Array.isArray(input.terminals))
    return null;
  const terminals: TerminalMetadata[] = [];
  for (const value of input.terminals) {
    const terminal = parseTerminalMetadata(value);
    if (!terminal) return null;
    terminals.push(terminal);
  }
  return { success: true, terminals };
}

export function parseTerminalCreateResponse(
  value: unknown,
): TerminalCreateResponse | null {
  const input = record(value);
  if (!input || input.success !== true) return null;
  const terminal = parseTerminalMetadata(input.terminal);
  return terminal ? { success: true, terminal } : null;
}

export function parseTerminalTerminateResponse(
  value: unknown,
): TerminalTerminateResponse | null {
  const input = record(value);
  if (!input || input.success !== true) return null;
  const terminalId = nonEmptyString(input.terminalId);
  if (!terminalId) return null;
  if (input.terminal === null)
    return { success: true, terminalId, terminal: null };
  const terminal = parseTerminalMetadata(input.terminal);
  return terminal ? { success: true, terminalId, terminal } : null;
}

export function cloneTerminalMetadata(
  metadata: TerminalMetadata,
): TerminalMetadata {
  return { ...metadata };
}
