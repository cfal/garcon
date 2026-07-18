const FIRST_RETRY_MS = 250;
const EXPONENTIAL_BASE_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const JITTER_FLOOR = 0.8;

export type RandomSource = () => number;

export function reconnectDelayMs(
	failedAttempts: number,
	random: RandomSource = Math.random,
): number {
	if (failedAttempts === 0) return FIRST_RETRY_MS;

	const backoff = Math.min(EXPONENTIAL_BASE_MS * Math.pow(2, failedAttempts - 1), MAX_RETRY_MS);
	const jitter = JITTER_FLOOR + random() * (1 - JITTER_FLOOR);
	return Math.round(backoff * jitter);
}
