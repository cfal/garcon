export interface RelativeTimestamp {
	label: string;
	tooltip: string;
}

const LONG_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'medium',
	timeStyle: 'short',
});

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, {
	numeric: 'always',
	style: 'narrow',
});

const NOW_FORMATTER = new Intl.RelativeTimeFormat(undefined, {
	numeric: 'auto',
	style: 'narrow',
});

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

interface RelativeTimeBucket {
	maxMs: number;
	divisorMs: number;
	unit: Intl.RelativeTimeFormatUnit;
}

const RELATIVE_TIME_BUCKETS: RelativeTimeBucket[] = [
	{ maxMs: HOUR_MS, divisorMs: MINUTE_MS, unit: 'minute' },
	{ maxMs: DAY_MS, divisorMs: HOUR_MS, unit: 'hour' },
	{ maxMs: MONTH_MS, divisorMs: DAY_MS, unit: 'day' },
	{ maxMs: YEAR_MS, divisorMs: MONTH_MS, unit: 'month' },
	{ maxMs: Number.POSITIVE_INFINITY, divisorMs: YEAR_MS, unit: 'year' },
];

function formatRelativeLabel(timestamp: Date, currentTime: Date): string {
	const elapsedMs = currentTime.getTime() - timestamp.getTime();
	const absoluteElapsedMs = Math.abs(elapsedMs);

	if (absoluteElapsedMs < MINUTE_MS) {
		return NOW_FORMATTER.format(0, 'second');
	}

	const bucket =
		RELATIVE_TIME_BUCKETS.find((candidate) => absoluteElapsedMs < candidate.maxMs) ??
		RELATIVE_TIME_BUCKETS[RELATIVE_TIME_BUCKETS.length - 1]!;
	const count = Math.max(1, Math.floor(absoluteElapsedMs / bucket.divisorMs));
	const signedCount = elapsedMs < 0 ? count : -count;

	return RELATIVE_TIME_FORMATTER.format(signedCount, bucket.unit);
}

export function formatRelativeTimestamp(
	timestamp: string | null | undefined,
	currentTime: Date,
): RelativeTimestamp | null {
	if (!timestamp) return null;

	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.getTime())) return null;

	return {
		label: formatRelativeLabel(parsed, currentTime),
		tooltip: LONG_DATE_TIME_FORMATTER.format(parsed),
	};
}
