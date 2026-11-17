import type { PrimaryWsServerMessage } from '../../common/ws-protocol.js';

export interface ExpectedTurn {
  chatId: string;
  turnId: string;
  outcome: 'finished' | 'interrupted';
}

export function terminalOutcomesMatch(expected: ExpectedTurn[], events: readonly PrimaryWsServerMessage[]): boolean {
  if (new Set(expected.map(turn => JSON.stringify([turn.chatId, turn.turnId]))).size !== expected.length) return false;
  const terminals = events.filter(event => event.type === 'agent-run-finished' || event.type === 'agent-run-failed');
  return terminals.length === expected.length && expected.every(turn => {
    const matching = terminals.filter(event => event.chatId === turn.chatId && event.turnId === turn.turnId);
    return matching.length === 1 && matching[0].type === 'agent-run-finished'
      && matching[0].exitCode === 0 && matching[0].outcome === turn.outcome;
  });
}
