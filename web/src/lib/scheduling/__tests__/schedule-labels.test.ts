import { describe, expect, it } from 'vitest';
import { SCHEDULED_PROMPT_RUN_OUTCOMES } from '$shared/scheduled-prompts';
import {
	recurringCadenceLabel,
	scheduledInstantLabel,
	scheduledPromptTitle,
	scheduledRunSourceLabel,
	scheduledRunOutcomeLabel,
	scheduledRunOutcomeTone,
} from '../schedule-labels';
import { formatScheduledInstant } from '../local-schedule';

describe('schedule labels', () => {
	it('names runs on nearby days and dates the rest', () => {
		const now = new Date(2030, 0, 2, 12, 0, 0, 0);
		expect(scheduledInstantLabel(new Date(2030, 0, 1, 9, 0).toISOString(), now)).toMatch(
			/^Yesterday at /,
		);
		expect(scheduledInstantLabel(new Date(2030, 0, 2, 23, 0).toISOString(), now)).toMatch(
			/^Today at /,
		);
		expect(scheduledInstantLabel(new Date(2030, 0, 3, 0, 5).toISOString(), now)).toMatch(
			/^Tomorrow at /,
		);
		const later = new Date(2030, 0, 9, 9, 0).toISOString();
		expect(scheduledInstantLabel(later, now)).toBe(formatScheduledInstant(later));
	});

	it('titles a prompt by its first line', () => {
		expect(scheduledPromptTitle('  Review the build  \nSecond line')).toBe('Review the build');
		expect(scheduledPromptTitle('\nSecond line')).toBe('Untitled prompt');
		expect(scheduledPromptTitle('<garcon-schedule-action />')).toBe('Scheduled action');
	});

	it('names a run from its recorded label rather than the current prompt', () => {
		const run = {
			at: '2030-01-01T09:00:00.000Z',
			scheduledPromptId: 'prompt-1',
			promptLabel: 'Review the build',
			outcome: 'sent' as const,
			chatId: '123',
			message: 'Prompt sent to chat 123.',
		};
		expect(scheduledRunSourceLabel(run)).toBe('Review the build');
		expect(scheduledRunSourceLabel({ ...run, promptLabel: '' })).toBe('Scheduled action');
		expect(scheduledRunSourceLabel({ ...run, scheduledPromptId: null, promptLabel: null })).toBe(
			'Scheduler',
		);
	});

	it('labels common cadences by name', () => {
		expect(recurringCadenceLabel(60)).toBe('Hourly');
		expect(recurringCadenceLabel(1440)).toBe('Daily');
		expect(recurringCadenceLabel(10080)).toBe('Weekly');
		expect(recurringCadenceLabel(20160)).toBe('Every 14 days');
		expect(recurringCadenceLabel(15)).toBe('Every 15 minutes');
	});

	it('gives every run outcome a label and a tone', () => {
		const tones = SCHEDULED_PROMPT_RUN_OUTCOMES.map((outcome) => {
			expect(scheduledRunOutcomeLabel(outcome)).not.toBe('');
			return [outcome, scheduledRunOutcomeTone(outcome)];
		});
		expect(Object.fromEntries(tones)).toEqual({
			'created-chat': 'success',
			sent: 'success',
			queued: 'success',
			'skipped-busy': 'warning',
			missed: 'warning',
			failed: 'error',
		});
	});
});
