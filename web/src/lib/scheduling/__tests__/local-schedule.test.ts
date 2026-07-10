import { describe, expect, it } from 'vitest';
import {
	browserTimeZoneLabel,
	localDateTimeToUtcIso,
	localDateValue,
	localTimeValue,
	nextLocalTimeUtcIso,
} from '../local-schedule';
import {
	hasLeadingSlashCommand,
	normalizeScheduledTaskDefinitionInput,
} from '$shared/scheduled-tasks';

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
});

describe('scheduled prompt validation', () => {
	it('rejects only leading slash-command tokens', () => {
		expect(hasLeadingSlashCommand('  /compact later')).toBe(true);
		expect(hasLeadingSlashCommand('Review /compact references')).toBe(false);
		expect(hasLeadingSlashCommand('/home/project is the path')).toBe(false);
	});

	it('normalizes an every-N-day definition with an inclusive end instant', () => {
		const definition = normalizeScheduledTaskDefinitionInput({
			schedule: {
				type: 'recurring',
				firstRunAtUtc: '2030-01-02T09:00:00.000Z',
				intervalDays: 2,
				endAtUtc: '2030-01-10T09:00:00.000Z',
			},
			target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
			prompt: 'Continue the work',
		});
		expect(definition?.schedule).toEqual({
			type: 'recurring',
			firstRunAtUtc: '2030-01-02T09:00:00.000Z',
			intervalDays: 2,
			endAtUtc: '2030-01-10T09:00:00.000Z',
		});
	});
});
