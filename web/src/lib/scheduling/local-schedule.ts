function pad(value: number): string {
	return String(value).padStart(2, '0');
}

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
