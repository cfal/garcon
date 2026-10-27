// Costs are in US dollars, so amounts use en-US currency formatting like the price sources.
const CURRENCY = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});
const COMPACT_CURRENCY = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	notation: 'compact',
	maximumFractionDigits: 1,
});
const INTEGER = new Intl.NumberFormat('en-US');
const DAY_SHORT = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: 'numeric',
	timeZone: 'UTC',
});
const DAY_LONG = new Intl.DateTimeFormat('en-US', {
	weekday: 'short',
	month: 'short',
	day: 'numeric',
	timeZone: 'UTC',
});
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: 'numeric',
	year: 'numeric',
	timeZone: 'UTC',
});

export function formatUsd(value: number): string {
	if (value > 0 && value < 0.005) return '<$0.01';
	return CURRENCY.format(value);
}

/** Axis labels: whole and compact amounts stay short at every scale. */
export function formatUsdAxis(value: number): string {
	if (value >= 1000) return COMPACT_CURRENCY.format(value);
	if (Number.isInteger(value)) return `$${value}`;
	return value < 1 ? `$${value.toFixed(2)}` : `$${trimFraction(value)}`;
}

export function formatTokens(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e12) return `${trimFraction(value / 1e12)}T`;
	if (abs >= 1e9) return `${trimFraction(value / 1e9)}B`;
	if (abs >= 1e6) return `${trimFraction(value / 1e6)}M`;
	if (abs >= 1e3) return `${trimFraction(value / 1e3)}K`;
	return INTEGER.format(Math.round(value));
}

export function formatCount(value: number): string {
	return INTEGER.format(Math.round(value));
}

export function formatPercent(share: number, digits = 1): string {
	const percent = share * 100;
	const smallest = 10 ** -digits;
	if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`;
	return `${percent.toFixed(digits)}%`;
}

export function formatDayShort(day: string): string {
	const time = Date.parse(`${day}T00:00:00Z`);
	return Number.isNaN(time) ? day : DAY_SHORT.format(time);
}

export function formatDayLong(day: string): string {
	const time = Date.parse(`${day}T00:00:00Z`);
	return Number.isNaN(time) ? day : DAY_LONG.format(time);
}

export function formatDayWithYear(day: string): string {
	const time = Date.parse(`${day}T00:00:00Z`);
	return Number.isNaN(time) ? day : DAY_WITH_YEAR.format(time);
}

function trimFraction(value: number): string {
	const abs = Math.abs(value);
	const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
	return value
		.toFixed(digits)
		.replace(/\.0+$/u, '')
		.replace(/(\.\d*?)0+$/u, '$1');
}
