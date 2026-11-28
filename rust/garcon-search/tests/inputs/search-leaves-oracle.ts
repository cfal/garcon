import { parseChatMessage } from '../../../../common/chat-types.ts';
import { projectSearchMessage as project } from '../../../../server-agents/common/src/search/message-projector.ts';
import { QueryLatencyStats } from '../../../../server-agents/common/src/search/query-latency-stats.ts';

export function acceptsMessage(value: unknown): boolean {
  return parseChatMessage(value) !== null;
}

export function projectSearchMessage(value: unknown) {
  const message = parseChatMessage(value);
  if (!message) throw new Error('Invalid fixture message');
  return project(message);
}

type Operation =
  | ['served', number, number, number]
  | ['timed-out']
  | ['busy'];

// The service supplies elapsed performance.now() differences, not arbitrary
// JavaScript numbers. Keep the rounded components and their sum wire-safe.
export function acceptsLatencyOperations(value: unknown): boolean {
  return Array.isArray(value) && value.every(op => Array.isArray(op)
    && (op[0] === 'served' && op.length === 4 && op.slice(1).every(
      value => typeof value === 'number' && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 2,
    ) || (op[0] === 'timed-out' || op[0] === 'busy') && op.length === 1));
}

export function queryLatencySnapshot(operations: Operation[]) {
  const stats = new QueryLatencyStats();
  for (const op of operations) {
    switch (op[0]) {
      case 'served': stats.recordServed({ admissionMs: op[1], executionMs: op[2], totalMs: op[3] }); break;
      case 'timed-out': stats.recordTimedOut(); break;
      case 'busy': stats.recordRejectedBusy(); break;
    }
  }
  return stats.snapshot();
}
