export const CHAT_ACTIVITY_STATUSES = [
  'working', 'complete', 'error', 'pending-user-action',
] as const;

export type ChatActivityStatus = typeof CHAT_ACTIVITY_STATUSES[number];
export type ChatRunOutcome = 'finished' | 'failed' | 'interrupted';

export function isChatActivityStatus(value: unknown): value is ChatActivityStatus {
  return CHAT_ACTIVITY_STATUSES.some(status => status === value);
}
