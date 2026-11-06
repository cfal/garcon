export const RUN_OR_STEER_MAX_ATTEMPTS = 3;
export const RUN_OR_STEER_RETRY_DELAY_MS = 50;

export function nextRunOrSteerRoute(
  route: 'run' | 'steer', status: number, errorCode?: string | null,
): 'run' | 'steer' | null {
  if (status !== 409) return null;
  if (route === 'run' && errorCode === 'SESSION_BUSY') return 'steer';
  if (route === 'steer' && (errorCode === 'STEER_TURN_UNAVAILABLE' || errorCode === 'STEER_TURN_CHANGED')) return 'run';
  return null;
}
