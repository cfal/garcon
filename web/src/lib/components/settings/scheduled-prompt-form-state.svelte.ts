import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
import {
	advanceRecurringAnchor,
	localDateTimeToUtcIso,
	localDateValue,
	localTimeValue,
	nextLocalTimeUtcIso,
	recurringOccurrences,
} from '$lib/scheduling/local-schedule';
import {
	SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX,
	SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN,
	SCHEDULED_PROMPT_MAX_LENGTH,
	hasLeadingSlashCommand,
	scheduledPromptFitsRenderedLimit,
	type ScheduledPrompt,
	type ScheduledPromptDefinitionInput,
} from '$shared/scheduled-prompts';
import * as m from '$lib/paraglide/messages.js';

const MINUTES_BY_UNIT = { minutes: 1, hours: 60, days: 1440 } as const;

export const SCHEDULE_INTERVAL_PRESET_MINUTES = [15, 60, 1440, 10080] as const;

export type ScheduleIssue = 'incomplete' | 'past' | 'interval' | 'end-before-start';

type ScheduleInput = ScheduledPromptDefinitionInput['schedule'];
type ScheduleEvaluation =
	| { schedule: ScheduleInput; issue: null }
	| { schedule: null; issue: ScheduleIssue };

export interface SchedulePreview {
	issue: ScheduleIssue | null;
	// Empty while `issue` is set.
	upcomingRuns: string[];
	endAt: string | null;
}

function invalidSchedule(issue: ScheduleIssue): ScheduleEvaluation {
	return { schedule: null, issue };
}

export interface ScheduledPromptFormStateOptions {
	executors?: ExecutorsStore;
	get selectableAgentIds(): readonly SessionAgentId[];
}

export class ScheduledPromptFormState {
	readonly startup: NewChatFormState;
	mode = $state<'create' | 'edit'>('create');
	scheduledPromptId = $state<string | null>(null);
	scheduleType = $state<'once' | 'recurring'>('once');
	date = $state('');
	time = $state('09:00');
	intervalAmount = $state(1);
	intervalUnit = $state<keyof typeof MINUTES_BY_UNIT>('days');
	recurrenceEnd = $state<'forever' | 'until'>('forever');
	endDate = $state('');
	targetType = $state<'new-chat' | 'existing-chat'>('new-chat');
	existingChatId = $state<string | null>(null);
	busyBehavior = $state<'queue' | 'skip'>('queue');
	prompt = $state('');
	saving = $state(false);
	promptTransformPending = $state(false);
	error = $state<string | null>(null);
	#originalNextRunAt: string | null = null;
	#originalLocalDate: string | null = null;
	#originalLocalTime: string | null = null;
	#originalEndAt: string | null = null;
	#originalEndDate: string | null = null;

	constructor(
		modelCatalog: ModelCatalogStore,
		remoteSettings: RemoteSettingsStore,
		private readonly sessions: Pick<ChatSessionsStore, 'hasChat' | 'isDraft'>,
		private readonly options: ScheduledPromptFormStateOptions,
	) {
		this.startup = new NewChatFormState({
			modelCatalog,
			executors: options.executors,
			remoteSettings,
			get selectableAgentIds() {
				return options.selectableAgentIds;
			},
		});
	}

	get canSave(): boolean {
		return this.canSaveAt(new Date());
	}

	canSaveAt(now: Date): boolean {
		return (
			!this.saving &&
			!this.promptTransformPending &&
			this.promptError === null &&
			this.scheduleIssue(now) === null &&
			this.targetValid
		);
	}

	get intervalMinutes(): number {
		return this.intervalAmount * MINUTES_BY_UNIT[this.intervalUnit];
	}

	get intervalAmountMax(): number {
		return Math.floor(SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX / MINUTES_BY_UNIT[this.intervalUnit]);
	}

	get promptError(): string | null {
		if (!this.prompt.trim()) return m.scheduled_prompts_prompt_required();
		if (this.prompt.trim().length > SCHEDULED_PROMPT_MAX_LENGTH) {
			return m.scheduled_prompts_prompt_too_long();
		}
		if (!scheduledPromptFitsRenderedLimit(this.prompt.trim())) {
			return m.scheduled_prompts_prompt_rendered_too_long();
		}
		if (hasLeadingSlashCommand(this.prompt)) return m.scheduled_prompts_slash_command_error();
		return null;
	}

	scheduleIssue(now = new Date()): ScheduleIssue | null {
		return this.#evaluateSchedule(now).issue;
	}

	// Describes what the current inputs would do, so the form can show the first runs
	// or the reason the schedule cannot be saved.
	schedulePreview(runCount: number, now = new Date()): SchedulePreview {
		const { schedule, issue } = this.#evaluateSchedule(now);
		if (!schedule) return { issue, upcomingRuns: [], endAt: null };
		if (schedule.type === 'once') {
			return { issue: null, upcomingRuns: [schedule.runAtUtc], endAt: null };
		}
		return {
			issue: null,
			upcomingRuns: recurringOccurrences(
				schedule.firstRunAtUtc,
				schedule.intervalMinutes,
				schedule.endAtUtc,
				runCount,
			),
			endAt: schedule.endAtUtc,
		};
	}

	// Expresses the interval in the largest unit that divides it evenly.
	setIntervalMinutes(intervalMinutes: number): void {
		if (intervalMinutes % MINUTES_BY_UNIT.days === 0) {
			this.intervalUnit = 'days';
			this.intervalAmount = intervalMinutes / MINUTES_BY_UNIT.days;
		} else if (intervalMinutes % MINUTES_BY_UNIT.hours === 0) {
			this.intervalUnit = 'hours';
			this.intervalAmount = intervalMinutes / MINUTES_BY_UNIT.hours;
		} else {
			this.intervalUnit = 'minutes';
			this.intervalAmount = intervalMinutes;
		}
	}

	get targetValid(): boolean {
		if (this.targetType === 'existing-chat') {
			return Boolean(
				this.existingChatId &&
				this.sessions.hasChat(this.existingChatId) &&
				!this.sessions.isDraft(this.existingChatId),
			);
		}
		return (
			this.startup.settingsLoaded &&
			this.startup.executorReady &&
			this.startup.modelCatalogValidated &&
			this.options.selectableAgentIds.includes(this.startup.agentId) &&
			this.startup.validationStatus === 'valid' &&
			this.startup.resolvedModelSelection !== null
		);
	}

	dispose(): void {
		this.startup.dispose();
	}

	async initialize(scheduledPrompt: ScheduledPrompt | null): Promise<void> {
		this.error = null;
		this.saving = false;
		const defaultRunAt = nextLocalTimeUtcIso(this.time);
		if (defaultRunAt) this.date = localDateValue(new Date(defaultRunAt));
		if (!scheduledPrompt) {
			await this.startup.loadSettingsAndModels();
			return;
		}

		this.mode = 'edit';
		this.scheduledPromptId = scheduledPrompt.id;
		this.prompt = scheduledPrompt.prompt;
		this.scheduleType = scheduledPrompt.schedule.type;
		const next = new Date(scheduledPrompt.schedule.nextRunAt);
		this.date = localDateValue(next);
		this.time = localTimeValue(next);
		if (scheduledPrompt.schedule.type === 'recurring') {
			this.#originalNextRunAt = scheduledPrompt.schedule.nextRunAt;
			this.#originalLocalDate = this.date;
			this.#originalLocalTime = this.time;
			this.setIntervalMinutes(scheduledPrompt.schedule.intervalMinutes);
			this.recurrenceEnd = scheduledPrompt.schedule.endAt ? 'until' : 'forever';
			this.endDate = scheduledPrompt.schedule.endAt
				? localDateValue(new Date(scheduledPrompt.schedule.endAt))
				: '';
			this.#originalEndAt = scheduledPrompt.schedule.endAt;
			this.#originalEndDate = this.endDate || null;
		}

		this.targetType = scheduledPrompt.target.type;
		if (scheduledPrompt.target.type === 'existing-chat') {
			this.existingChatId = scheduledPrompt.target.chatId;
			this.busyBehavior = scheduledPrompt.target.busyBehavior;
			await this.startup.loadSettingsAndModels();
			return;
		}
		this.startup.selectExecutor(scheduledPrompt.target.executorId);
		this.startup.restoreSelection(scheduledPrompt.target.agentId, {
			model: scheduledPrompt.target.model,
			apiProviderId: scheduledPrompt.target.apiProviderId,
			modelEndpointId: scheduledPrompt.target.modelEndpointId,
			modelProtocol: scheduledPrompt.target.modelProtocol,
		});
		this.startup.projectPath = scheduledPrompt.target.projectPath;
		this.startup.restoreExecutionModes(
			scheduledPrompt.target.permissionMode,
			scheduledPrompt.target.thinkingMode,
		);
		this.startup.replaceAgentSettingsById(scheduledPrompt.target.agentSettingsById);
		this.startup.chatTags = [...scheduledPrompt.target.tags];
		this.startup.showTagInput = false;
		this.startup.preambles.restoreChoice(scheduledPrompt.target.preambleChoice);
		await this.startup.loadSettingsAndModels();
		this.startup.validatePath();
	}

	buildDefinition(now = new Date()): ScheduledPromptDefinitionInput | null {
		const { schedule } = this.#evaluateSchedule(now);
		if (!schedule || !this.targetValid || this.promptError) return null;
		if (this.targetType === 'existing-chat') {
			if (!this.existingChatId) return null;
			return {
				schedule,
				target: {
					type: 'existing-chat',
					chatId: this.existingChatId,
					busyBehavior: this.busyBehavior,
				},
				prompt: this.prompt.trim(),
			};
		}
		const selection = this.startup.resolvedModelSelection;
		if (!selection) return null;
		return {
			schedule,
			target: {
				type: 'new-chat',
				...(this.startup.executorId === 'local' ? {} : { executorId: this.startup.executorId }),
				agentId: this.startup.agentId,
				projectPath: this.startup.nonblankPath,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
				permissionMode: this.startup.permissionMode,
				thinkingMode: this.startup.thinkingMode,
				agentSettingsById: this.startup.agentSettingsById,
				tags: [...this.startup.chatTags],
				preambleChoice: this.startup.preambles.choiceSnapshot,
			},
			prompt: this.prompt.trim(),
		};
	}

	private buildRecurringEndAtUtc(): string | null {
		if (this.recurrenceEnd !== 'until') return null;
		if (
			this.#originalEndAt &&
			this.#originalEndDate === this.endDate &&
			this.#originalLocalTime === this.time
		) {
			return this.#originalEndAt;
		}
		return localDateTimeToUtcIso(this.endDate, this.time);
	}

	// An untouched recurring anchor keeps its exact UTC instant; one that passed while
	// the dialog was open advances by whole intervals instead of becoming invalid.
	#recurringFirstRunAt(
		anchor: string | null,
		intervalMinutes: number,
		minimumMs: number,
	): string | null {
		if (
			this.#originalNextRunAt &&
			this.#originalLocalDate === this.date &&
			this.#originalLocalTime === this.time
		) {
			return advanceRecurringAnchor(this.#originalNextRunAt, intervalMinutes, minimumMs);
		}
		return anchor;
	}

	#evaluateSchedule(now: Date): ScheduleEvaluation {
		const minimumMs = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
		const anchor = localDateTimeToUtcIso(this.date, this.time);
		if (this.scheduleType === 'once') {
			if (!anchor) return invalidSchedule('incomplete');
			if (Date.parse(anchor) < minimumMs) return invalidSchedule('past');
			return { schedule: { type: 'once', runAtUtc: anchor }, issue: null };
		}
		const intervalMinutes = this.intervalMinutes;
		if (
			!Number.isSafeInteger(this.intervalAmount) ||
			!Number.isSafeInteger(intervalMinutes) ||
			intervalMinutes < SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN ||
			intervalMinutes > SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX
		) {
			return invalidSchedule('interval');
		}
		const firstRunAtUtc = this.#recurringFirstRunAt(anchor, intervalMinutes, minimumMs);
		if (!firstRunAtUtc) return invalidSchedule('incomplete');
		if (Date.parse(firstRunAtUtc) < minimumMs) return invalidSchedule('past');
		const endAtUtc = this.buildRecurringEndAtUtc();
		if (this.recurrenceEnd === 'until') {
			if (!endAtUtc) return invalidSchedule('incomplete');
			if (endAtUtc < firstRunAtUtc) return invalidSchedule('end-before-start');
		}
		return {
			schedule: { type: 'recurring', firstRunAtUtc, intervalMinutes, endAtUtc },
			issue: null,
		};
	}
}
