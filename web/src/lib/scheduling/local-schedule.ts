function pad(value: number): string {
	return String(value).padStart(2, '0');
}

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

export function localDateValue(value: Date): string {
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function localTimeValue(value: Date): string {
	return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function localDateTimeToUtcIso(dateValue: string, timeValue: string): string | null {
	const [year, month, day] = dateValue.split('-').map(Number);
	const [hour, minute] = timeValue.split(':').map(Number);
	if (
		![year, month, day, hour, minute].every(Number.isInteger) ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour < 0 ||
		hour > 23 ||
		minute < 0 ||
		minute > 59
	)
		return null;
	const result = new Date(year, month - 1, day, hour, minute, 0, 0);
	if (
		result.getFullYear() !== year ||
		result.getMonth() !== month - 1 ||
		result.getDate() !== day ||
		result.getHours() !== hour ||
		result.getMinutes() !== minute
	)
		return null;
	return result.toISOString();
}

export function nextLocalTimeUtcIso(timeValue: string, now = new Date()): string | null {
	const [hour, minute] = timeValue.split(':').map(Number);
	if (
		!Number.isInteger(hour) ||
		!Number.isInteger(minute) ||
		hour < 0 ||
		hour > 23 ||
		minute < 0 ||
		minute > 59
	) {
		return null;
	}
	const result = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
	if (result.getTime() <= now.getTime()) result.setDate(result.getDate() + 1);
	return result.toISOString();
}

export function browserTimeZoneLabel(now = new Date()): string {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
	const offset = new Intl.DateTimeFormat(undefined, {
		timeZoneName: 'longOffset',
		hour: '2-digit',
	})
		.formatToParts(now)
		.find((part) => part.type === 'timeZoneName')?.value;
	return `${zone}${offset ? ` (${offset})` : ''}`;
}

export function formatScheduledInstant(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(value));
}

export function formatScheduledDate(value: string): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

export function formatScheduledTime(value: string): string {
	return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(value));
}

// Counts browser-local calendar days, so a run at 00:30 tomorrow is one day away even
// when it is less than 24 hours from now.
export function localCalendarDayOffset(value: string, now = new Date()): number {
	const target = new Date(value);
	const targetDay = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
	const currentDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((targetDay - currentDay) / (MINUTES_PER_DAY * MINUTE_MS));
}

export function recurringOccurrences(
	firstRunAt: string,
	intervalMinutes: number,
	endAt: string | null,
	count: number,
): string[] {
	const firstMs = Date.parse(firstRunAt);
	const endMs = endAt === null ? Number.POSITIVE_INFINITY : Date.parse(endAt);
	if (!Number.isFinite(firstMs) || intervalMinutes <= 0) return [];
	const occurrences: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const occurrenceMs = firstMs + index * intervalMinutes * MINUTE_MS;
		if (occurrenceMs > endMs) break;
		occurrences.push(new Date(occurrenceMs).toISOString());
	}
	return occurrences;
}

// Moves a recurring anchor forward by whole intervals until it reaches `minimumMs`,
// matching how the server skips occurrences that passed while a schedule was idle.
export function advanceRecurringAnchor(
	anchor: string,
	intervalMinutes: number,
	minimumMs: number,
): string {
	const anchorMs = Date.parse(anchor);
	if (anchorMs >= minimumMs) return anchor;
	const intervalMs = intervalMinutes * MINUTE_MS;
	const steps = Math.ceil((minimumMs - anchorMs) / intervalMs);
	return new Date(anchorMs + steps * intervalMs).toISOString();
}

export function formatCompactTimeUntil(value: string, now = new Date()): string | null {
	const remainingMs = Date.parse(value) - now.getTime();
	if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;

	const totalMinutes = Math.max(1, Math.floor(remainingMs / MINUTE_MS));
	const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
	const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
	const minutes = totalMinutes % MINUTES_PER_HOUR;

	return [
		days > 0 ? `${days}d` : '',
		hours > 0 ? `${hours}h` : '',
		minutes > 0 ? `${minutes}m` : '',
	]
		.filter(Boolean)
		.join('');
}
