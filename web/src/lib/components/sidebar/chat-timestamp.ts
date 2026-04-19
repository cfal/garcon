export interface SidebarChatTimestamp {
	dateLabel: string;
	timeLabel: string;
	tooltip: string;
}

const SHORT_MONTH_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
	month: 'short',
	day: 'numeric',
});

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'short',
});

const SHORT_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
	timeStyle: 'short',
});

const LONG_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'medium',
	timeStyle: 'short',
});

export function formatSidebarChatTimestamp(
	timestamp: string | null,
	currentTime: Date,
): SidebarChatTimestamp | null {
	if (!timestamp) return null;

	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.getTime())) return null;

	return {
		dateLabel: parsed.getFullYear() === currentTime.getFullYear()
			? SHORT_MONTH_DAY_FORMATTER.format(parsed)
			: SHORT_DATE_FORMATTER.format(parsed),
		timeLabel: SHORT_TIME_FORMATTER.format(parsed),
		tooltip: LONG_DATE_TIME_FORMATTER.format(parsed),
	};
}
