import { describe, expect, it } from 'vitest';
import { usageWindow } from '../usage-window';
import {
	DEFAULT_USAGE_PREFERENCES,
	readUsagePreferences,
	saveUsagePreferences,
} from '../usage-preferences';

describe('usage window', () => {
	it('ends today in the viewer zone and spans whole calendar days', () => {
		const now = new Date('2026-10-27T06:30:00Z');
		expect(usageWindow(7, now, 'UTC')).toEqual({
			sinceDay: '2026-10-21',
			untilDay: '2026-10-27',
			timeZone: 'UTC',
		});
		expect(usageWindow(7, now, 'America/Los_Angeles')).toEqual({
			sinceDay: '2026-10-20',
			untilDay: '2026-10-26',
			timeZone: 'America/Los_Angeles',
		});
		expect(usageWindow(30, new Date('2026-03-10T12:00:00Z'), 'UTC').sinceDay).toBe('2026-02-09');
	});

	it('falls back to UTC for an unknown zone', () => {
		expect(usageWindow(7, new Date('2026-10-27T06:30:00Z'), 'Nowhere/Zone').timeZone).toBe('UTC');
	});
});

describe('usage preferences', () => {
	it('round-trips valid preferences and ignores malformed storage', () => {
		let stored: string | null = null;
		const persistence = {
			read: () => stored,
			write: (value: string) => {
				stored = value;
			},
		};
		expect(readUsagePreferences(persistence)).toEqual(DEFAULT_USAGE_PREFERENCES);
		saveUsagePreferences({ windowDays: 90, metric: 'tokens' }, persistence);
		expect(readUsagePreferences(persistence)).toEqual({ windowDays: 90, metric: 'tokens' });
		stored = JSON.stringify({ windowDays: 14, metric: 'joules' });
		expect(readUsagePreferences(persistence)).toEqual(DEFAULT_USAGE_PREFERENCES);
		stored = '{';
		expect(readUsagePreferences(persistence)).toEqual(DEFAULT_USAGE_PREFERENCES);
	});
});
