import { describe, expect, it } from 'vitest';
import {
	advanceRecurringAnchor,
	browserTimeZoneLabel,
	formatCompactTimeUntil,
	localCalendarDayOffset,
	localDateTimeToUtcIso,
	localDateValue,
	localTimeValue,
	nextLocalTimeUtcIso,
	recurringOccurrences,
} from '../local-schedule';
import {
	hasLeadingSlashCommand,
	normalizeScheduledPromptDefinitionInput,
} from '$shared/scheduled-prompts';

describe('browser-local schedule conversion', () => {
	it('round-trips a valid local date and minute through an explicit UTC instant', () => {
		const iso = localDateTimeToUtcIso('2030-07-04', '13:25');
		expect(iso).not.toBeNull();
		const converted = new Date(iso!);
		expect(localDateValue(converted)).toBe('2030-07-04');
		expect(localTimeValue(converted)).toBe('13:25');
		expect(converted.getSeconds()).toBe(0);
	});

	it('rejects invalid calendar values', () => {
		expect(localDateTimeToUtcIso('2030-02-30', '09:00')).toBeNull();
		expect(localDateTimeToUtcIso('', '09:00')).toBeNull();
		expect(nextLocalTimeUtcIso('25:00', new Date())).toBeNull();
	});

	it('uses today when the local time is future and tomorrow after it passes', () => {
		const now = new Date(2030, 6, 4, 10, 30, 0, 0);
		const today = new Date(nextLocalTimeUtcIso('11:00', now)!);
		const tomorrow = new Date(nextLocalTimeUtcIso('09:00', now)!);
		expect(localDateValue(today)).toBe('2030-07-04');
		expect(localDateValue(tomorrow)).toBe('2030-07-05');
	});

	it('labels the browser timezone explicitly', () => {
		expect(browserTimeZoneLabel()).toMatch(/\S/);
	});

	it('formats compact future durations without seconds', () => {
		const now = new Date('2030-01-01T00:00:00.000Z');

		expect(formatCompactTimeUntil('2030-01-01T04:03:59.000Z', now)).toBe('4h3m');
		expect(formatCompactTimeUntil('2030-01-03T04:03:00.000Z', now)).toBe('2d4h3m');
		expect(formatCompactTimeUntil('2030-01-02T00:00:00.000Z', now)).toBe('1d');
	});

	it('keeps the final partial minute visible and identifies elapsed instants', () => {
		const now = new Date('2030-01-01T00:00:00.000Z');

		expect(formatCompactTimeUntil('2030-01-01T00:00:01.000Z', now)).toBe('1m');
		expect(formatCompactTimeUntil(now.toISOString(), now)).toBeNull();
		expect(formatCompactTimeUntil('not-a-date', now)).toBeNull();
	});
});

describe('scheduled prompt validation', () => {
	it('rejects only leading slash-command tokens', () => {
		expect(hasLeadingSlashCommand('  /compact later')).toBe(true);
		expect(hasLeadingSlashCommand('Review /compact references')).toBe(false);
		expect(hasLeadingSlashCommand('/home/project is the path')).toBe(false);
	});

	it('normalizes an every-N-hour definition with an inclusive end instant', () => {
		const definition = normalizeScheduledPromptDefinitionInput({
			schedule: {
				type: 'recurring',
				firstRunAtUtc: '2030-01-02T09:00:00.000Z',
				intervalMinutes: 120,
				endAtUtc: '2030-01-10T09:00:00.000Z',
			},
			target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
			prompt: 'Continue the work',
		});
		expect(definition?.schedule).toEqual({
			type: 'recurring',
			firstRunAtUtc: '2030-01-02T09:00:00.000Z',
			intervalMinutes: 120,
			endAtUtc: '2030-01-10T09:00:00.000Z',
		});
	});
});

describe('schedule presentation helpers', () => {
	it('counts calendar days rather than elapsed hours', () => {
		const now = new Date(2030, 0, 1, 23, 30, 0, 0);
		expect(localCalendarDayOffset(new Date(2030, 0, 1, 23, 59).toISOString(), now)).toBe(0);
		expect(localCalendarDayOffset(new Date(2030, 0, 2, 0, 15).toISOString(), now)).toBe(1);
		expect(localCalendarDayOffset(new Date(2029, 11, 31, 23, 45).toISOString(), now)).toBe(-1);
		expect(localCalendarDayOffset(new Date(2030, 0, 8, 9, 0).toISOString(), now)).toBe(7);
	});

	it('lists recurring occurrences up to an inclusive end instant', () => {
		const first = '2030-01-01T09:00:00.000Z';
		expect(recurringOccurrences(first, 90, null, 3)).toEqual([
			'2030-01-01T09:00:00.000Z',
			'2030-01-01T10:30:00.000Z',
			'2030-01-01T12:00:00.000Z',
		]);
		expect(recurringOccurrences(first, 90, '2030-01-01T10:30:00.000Z', 3)).toEqual([
			'2030-01-01T09:00:00.000Z',
			'2030-01-01T10:30:00.000Z',
		]);
		expect(recurringOccurrences('invalid', 90, null, 3)).toEqual([]);
		expect(recurringOccurrences(first, 0, null, 3)).toEqual([]);
	});

	it('advances a passed anchor by whole intervals and keeps a future one', () => {
		const anchor = '2030-01-01T09:00:00.000Z';
		expect(advanceRecurringAnchor(anchor, 60, Date.parse('2030-01-01T08:00:00.000Z'))).toBe(anchor);
		expect(advanceRecurringAnchor(anchor, 60, Date.parse(anchor))).toBe(anchor);
		expect(advanceRecurringAnchor(anchor, 60, Date.parse('2030-01-01T09:01:00.000Z'))).toBe(
			'2030-01-01T10:00:00.000Z',
		);
		expect(advanceRecurringAnchor(anchor, 90, Date.parse('2030-01-01T12:00:00.000Z'))).toBe(
			'2030-01-01T12:00:00.000Z',
		);
	});
});
