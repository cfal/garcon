import type { UsageReadRequest, UsageWindowDays } from '$shared/usage';

export function viewerTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/** The last `days` calendar days in the zone, ending today. */
export function usageWindow(
	days: UsageWindowDays,
	now: Date = new Date(),
	timeZone: string = viewerTimeZone(),
): UsageReadRequest {
	let zone = timeZone;
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
	} catch {
		zone = 'UTC';
		format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
	}
	const untilDay = format.format(now);
	// Calendar arithmetic in UTC; subtracting fixed milliseconds would cross DST days unevenly.
	const [year = 0, month = 1, dayOfMonth = 1] = untilDay.split('-').map((part) => Number(part));
	const sinceDay = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1))).toISOString().slice(0, 10);
	return { sinceDay, untilDay, timeZone: zone };
}
