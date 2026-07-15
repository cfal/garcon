import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
import {
	localDateTimeToUtcIso,
	localDateValue,
	localTimeValue,
	nextLocalTimeUtcIso,
} from '$lib/scheduling/local-schedule';
import {
	SCHEDULED_PROMPT_INTERVAL_DAYS_MAX,
	SCHEDULED_PROMPT_INTERVAL_DAYS_MIN,
	SCHEDULED_PROMPT_MAX_LENGTH,
	hasLeadingSlashCommand,
	type ScheduledPrompt,
	type ScheduledPromptDefinitionInput,
} from '$shared/scheduled-prompts';
import * as m from '$lib/paraglide/messages.js';

export class ScheduledPromptFormState {
	readonly startup: NewChatFormState;
	mode = $state<'create' | 'edit'>('create');
	scheduledPromptId = $state<string | null>(null);
	scheduleType = $state<'once' | 'recurring'>('once');
	date = $state('');
	time = $state('09:00');
	intervalDays = $state(1);
	recurrenceEnd = $state<'forever' | 'until'>('forever');
	endDate = $state('');
	targetType = $state<'new-chat' | 'existing-chat'>('new-chat');
	existingChatId = $state<string | null>(null);
	busyBehavior = $state<'queue' | 'skip'>('queue');
	prompt = $state('');
	saving = $state(false);
	error = $state<string | null>(null);
	#originalNextRunAt: string | null = null;
	#originalLocalTime: string | null = null;
	#originalEndAt: string | null = null;
	#originalEndDate: string | null = null;

	constructor(
		private readonly modelCatalog: ModelCatalogStore,
		remoteSettings: RemoteSettingsStore,
		private readonly sessions: Pick<ChatSessionsStore, 'hasChat' | 'isDraft'>,
	) {
		this.startup = new NewChatFormState(modelCatalog, remoteSettings);
	}

	get canSave(): boolean {
		return (
			!this.saving &&
			this.prompt.trim().length > 0 &&
			this.prompt.trim().length <= SCHEDULED_PROMPT_MAX_LENGTH &&
			!hasLeadingSlashCommand(this.prompt) &&
			this.scheduleValid &&
			this.targetValid
		);
	}

	get promptError(): string | null {
		if (!this.prompt.trim()) return m.scheduled_prompts_prompt_required();
		if (this.prompt.trim().length > SCHEDULED_PROMPT_MAX_LENGTH) {
			return m.scheduled_prompts_prompt_too_long();
		}
		if (hasLeadingSlashCommand(this.prompt)) return m.scheduled_prompts_slash_command_error();
		return null;
	}

	get scheduleValid(): boolean {
		return this.buildSchedule(new Date()) !== null;
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
			this.startup.validationStatus === 'valid' &&
			Boolean(this.startup.modelValue)
		);
	}

	async initialize(scheduledPrompt: ScheduledPrompt | null): Promise<void> {
		this.error = null;
		this.saving = false;
		const defaultDate = new Date();
		defaultDate.setDate(defaultDate.getDate() + 1);
		this.date = localDateValue(defaultDate);
		await this.startup.loadSettingsAndModels();
		if (!scheduledPrompt) return;

		this.mode = 'edit';
		this.scheduledPromptId = scheduledPrompt.id;
		this.prompt = scheduledPrompt.prompt;
		this.scheduleType = scheduledPrompt.schedule.type;
		const next = new Date(scheduledPrompt.schedule.nextRunAt);
		this.date = localDateValue(next);
		this.time = localTimeValue(next);
		if (scheduledPrompt.schedule.type === 'recurring') {
			this.#originalNextRunAt = scheduledPrompt.schedule.nextRunAt;
			this.#originalLocalTime = this.time;
			this.intervalDays = scheduledPrompt.schedule.intervalDays;
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
			return;
		}
		this.startup.selectAgent(scheduledPrompt.target.agentId);
		this.startup.applyResolvedModel(
			scheduledPrompt.target.agentId,
			scheduledPrompt.target.model,
			scheduledPrompt.target.modelEndpointId,
		);
		this.startup.projectPath = scheduledPrompt.target.projectPath;
		this.startup.setPermissionMode(scheduledPrompt.target.permissionMode);
		this.startup.setThinkingMode(scheduledPrompt.target.thinkingMode);
		this.startup.setClaudeThinkingMode(scheduledPrompt.target.claudeThinkingMode);
		this.startup.setAmpAgentMode(scheduledPrompt.target.ampAgentMode);
		this.startup.chatTags = [...scheduledPrompt.target.tags];
		this.startup.showTagInput = false;
		this.startup.validatePath();
	}

	buildDefinition(now = new Date()): ScheduledPromptDefinitionInput | null {
		const schedule = this.buildSchedule(now);
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
		const selection = this.modelCatalog.selectionFor(this.startup.agentId, this.startup.modelValue);
		return {
			schedule,
			target: {
				type: 'new-chat',
				agentId: this.startup.agentId,
				projectPath: this.startup.trimmedPath,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
				permissionMode: this.startup.permissionMode,
				thinkingMode: this.startup.thinkingMode,
				claudeThinkingMode: this.startup.claudeThinkingMode,
				ampAgentMode: this.startup.ampAgentMode,
				tags: [...this.startup.chatTags],
			},
			prompt: this.prompt.trim(),
		};
	}

	private buildSchedule(now: Date): ScheduledPromptDefinitionInput['schedule'] | null {
		const minimum = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
		if (this.scheduleType === 'once') {
			const runAtUtc = localDateTimeToUtcIso(this.date, this.time);
			return runAtUtc && Date.parse(runAtUtc) >= minimum ? { type: 'once', runAtUtc } : null;
		}
		if (
			!Number.isSafeInteger(this.intervalDays) ||
			this.intervalDays < SCHEDULED_PROMPT_INTERVAL_DAYS_MIN ||
			this.intervalDays > SCHEDULED_PROMPT_INTERVAL_DAYS_MAX
		)
			return null;
		const firstRunAtUtc =
			this.#originalNextRunAt &&
			this.#originalLocalTime === this.time &&
			Date.parse(this.#originalNextRunAt) >= minimum
				? this.#originalNextRunAt
				: nextLocalTimeUtcIso(this.time, now);
		if (!firstRunAtUtc || Date.parse(firstRunAtUtc) < minimum) return null;
		const endAtUtc =
			this.recurrenceEnd !== 'until'
				? null
				: this.#originalEndAt &&
					  this.#originalEndDate === this.endDate &&
					  this.#originalLocalTime === this.time
					? this.#originalEndAt
					: localDateTimeToUtcIso(this.endDate, this.time);
		if (this.recurrenceEnd === 'until' && (!endAtUtc || endAtUtc < firstRunAtUtc)) return null;
		return { type: 'recurring', firstRunAtUtc, intervalDays: this.intervalDays, endAtUtc };
	}
}
