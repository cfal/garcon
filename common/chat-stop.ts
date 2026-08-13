export type ChatStopIntent = 'stop' | 'interrupt-and-send' | 'chat-deletion';

export const CHAT_STOP_OUTCOMES = [
  'interrupt-requested',
  'already-idle',
  'failed',
] as const;

export type ChatStopOutcome = typeof CHAT_STOP_OUTCOMES[number];

export function isStopSatisfied(outcome: ChatStopOutcome): boolean {
  return outcome !== 'failed';
}

export function isAbortAcknowledged(outcome: ChatStopOutcome): boolean {
  return outcome === 'interrupt-requested';
}
