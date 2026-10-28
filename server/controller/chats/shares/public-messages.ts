import { isRecord } from '../../../../common/json.js';

// Removes execution context a share renders nowhere: the executor and starting directory
// of command output and the reported working directory of a command result. Works on the
// stored JSON shape, so ledger messages and older share snapshots project identically.
export function withholdExecutionContext(message: unknown): unknown {
  if (!isRecord(message)) return message;
  if (message.type === 'command-output' && message.context !== null) {
    return { ...message, context: null };
  }
  if (message.type === 'command-result' && isRecord(message.result)
    && isRecord(message.result.cwd) && message.result.cwd.kind === 'reported') {
    return { ...message, result: { ...message.result, cwd: { kind: 'withheld' } } };
  }
  return message;
}
