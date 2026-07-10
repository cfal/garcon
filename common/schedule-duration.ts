export const SCHEDULE_IN_MIN_DELAY_MINUTES = 1;
export const SCHEDULE_IN_MAX_DELAY_MINUTES = 365 * 24 * 60;

export type ScheduleDurationError =
  | 'missing'
  | 'sub-minute-unsupported'
  | 'invalid-format'
  | 'too-short'
  | 'too-long';

export type ScheduleDurationResult =
  | { ok: true; minutes: number }
  | { ok: false; error: ScheduleDurationError };

const DURATION_RE = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i;

export function parseScheduleDuration(token: string): ScheduleDurationResult {
  const normalized = token.trim();
  if (!normalized) return { ok: false, error: 'missing' };
  if (/s/i.test(normalized)) return { ok: false, error: 'sub-minute-unsupported' };

  const match = DURATION_RE.exec(normalized);
  if (!match || !match.slice(1).some((part) => part !== undefined)) {
    return { ok: false, error: 'invalid-format' };
  }

  const [days, hours, minutes] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const total = days * 1_440 + hours * 60 + minutes;
  if (!Number.isSafeInteger(total)) return { ok: false, error: 'too-long' };
  if (total < SCHEDULE_IN_MIN_DELAY_MINUTES) return { ok: false, error: 'too-short' };
  if (total > SCHEDULE_IN_MAX_DELAY_MINUTES) return { ok: false, error: 'too-long' };
  return { ok: true, minutes: total };
}

export function scheduleInRunAt(now: Date, delayMinutes: number): string {
  const requested = now.getTime() + delayMinutes * 60_000;
  return new Date(Math.ceil(requested / 60_000) * 60_000).toISOString();
}
