import { isExecutorId } from './executors.js';

export interface TerminalReference {
  readonly executorId: string;
  readonly terminalRuntimeId: string;
  readonly sessionId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The opaque ID carries the complete reference through existing workspace placements.
export function terminalId(reference: TerminalReference): string {
  return `${reference.executorId}/${reference.terminalRuntimeId}/${reference.sessionId}`;
}

export function parseTerminalReference(value: unknown): TerminalReference | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 3) return null;
  const [executorId, terminalRuntimeId, sessionId] = parts;
  return isExecutorId(executorId) && UUID.test(terminalRuntimeId!) && UUID.test(sessionId!)
    ? { executorId, terminalRuntimeId: terminalRuntimeId!, sessionId: sessionId! } : null;
}
