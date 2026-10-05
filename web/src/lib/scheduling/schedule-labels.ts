import { parseGarconScheduleAction, scheduledPromptLabel } from '$shared/garcon-schedule';
import type {
	ScheduledPromptRunLogEntry,
	ScheduledPromptRunOutcome,
} from '$shared/scheduled-prompts';
import * as m from '$lib/paraglide/messages.js';
import {
	formatScheduledInstant,
	formatScheduledTime,
	localCalendarDayOffset,
} from './local-schedule';

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

export type ScheduledRunTone = 'success' | 'warning' | 'error';

export function scheduledPromptTitle(prompt: string): string {
	return (
		scheduledPromptLabel(prompt) ||
		(parseGarconScheduleAction(prompt)
			? m.scheduled_prompts_action()
			: m.scheduled_prompts_untitled())
	);
}

// Names a run from the label recorded with it, so the entry keeps its name after the
// prompt is edited or removed. A stored prompt always has text, so an empty label
// means a schedule action without a body.
export function scheduledRunSourceLabel(entry: ScheduledPromptRunLogEntry): string {
	if (entry.promptLabel === null) return m.scheduled_prompts_run_log_scheduler();
	return entry.promptLabel || m.scheduled_prompts_action();
}

export function recurringCadenceLabel(intervalMinutes: number): string {
	if (intervalMinutes === 1) return m.scheduled_prompts_every_minute();
	if (intervalMinutes === MINUTES_PER_HOUR) return m.scheduled_prompts_hourly();
	if (intervalMinutes === MINUTES_PER_DAY) return m.scheduled_prompts_daily();
	if (intervalMinutes === MINUTES_PER_WEEK) return m.scheduled_prompts_weekly();
	if (intervalMinutes % MINUTES_PER_DAY === 0) {
		return m.scheduled_prompts_every_days({ count: intervalMinutes / MINUTES_PER_DAY });
	}
	if (intervalMinutes % MINUTES_PER_HOUR === 0) {
		return m.scheduled_prompts_every_hours({ count: intervalMinutes / MINUTES_PER_HOUR });
	}
	return m.scheduled_prompts_every_minutes({ count: intervalMinutes });
}

// Names nearby days so a list of runs reads as "Today at 4:16 PM" rather than a full date.
export function scheduledInstantLabel(value: string, now = new Date()): string {
	const time = formatScheduledTime(value);
	switch (localCalendarDayOffset(value, now)) {
		case -1:
			return m.scheduled_prompts_yesterday_at({ time });
		case 0:
			return m.scheduled_prompts_today_at({ time });
		case 1:
			return m.scheduled_prompts_tomorrow_at({ time });
		default:
			return formatScheduledInstant(value);
	}
}

export function scheduledRunOutcomeLabel(outcome: ScheduledPromptRunOutcome): string {
	switch (outcome) {
		case 'created-chat':
			return m.scheduled_prompts_outcome_created_chat();
		case 'sent':
			return m.scheduled_prompts_outcome_sent();
		case 'queued':
			return m.scheduled_prompts_outcome_queued();
		case 'skipped-busy':
			return m.scheduled_prompts_outcome_skipped_busy();
		case 'missed':
			return m.scheduled_prompts_outcome_missed();
		case 'failed':
			return m.scheduled_prompts_outcome_failed();
	}
}

export function scheduledRunOutcomeTone(outcome: ScheduledPromptRunOutcome): ScheduledRunTone {
	switch (outcome) {
		case 'created-chat':
		case 'sent':
		case 'queued':
			return 'success';
		case 'skipped-busy':
		case 'missed':
			return 'warning';
		case 'failed':
			return 'error';
	}
}
