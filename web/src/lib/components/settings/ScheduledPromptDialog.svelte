<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import ScheduledChatPickerDialog from './ScheduledChatPickerDialog.svelte';
	import ScheduledNewChatComposer from './ScheduledNewChatComposer.svelte';
	import ScheduledPromptField from './ScheduledPromptField.svelte';
	import ScheduledPromptOption from './ScheduledPromptOption.svelte';
	import ScheduledPromptHeader from './ScheduledPromptHeader.svelte';
	import ScheduledPromptSchedulePreview from './ScheduledPromptSchedulePreview.svelte';
	import {
		SCHEDULE_INTERVAL_PRESET_MINUTES,
		ScheduledPromptFormState,
	} from './scheduled-prompt-form-state.svelte';
	import {
		getChatSessions,
		getLocalSettings,
		getModelCatalog,
		getExecutors,
		getRemoteSettings,
		getAppShell,
	} from '$lib/context';
	import { nonDirectAgentIds } from '$lib/agents/direct-agents.js';
	import { browserTimeZoneLabel, localDateValue } from '$lib/scheduling/local-schedule';
	import { recurringCadenceLabel } from '$lib/scheduling/schedule-labels';
	import { cn } from '$lib/utils/cn.js';
	import {
		SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN,
		type ScheduledPrompt,
		type ScheduledPromptDefinitionInput,
	} from '$shared/scheduled-prompts';
	import Search from '@lucide/svelte/icons/search';
	import * as m from '$lib/paraglide/messages.js';

	const PREVIEW_RUN_COUNT = 3;

	interface Props {
		open: boolean;
		scheduledPrompt: ScheduledPrompt | null;
		currentTime: Date;
		onSave: (definition: ScheduledPromptDefinitionInput) => Promise<void>;
		onClose: () => void;
	}

	let { open, scheduledPrompt, currentTime, onSave, onClose }: Props = $props();
	const rootModelCatalog = getModelCatalog();
	const executors = getExecutors();
	const localSettings = getLocalSettings();
	const remoteSettings = getRemoteSettings();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const snippetContext = $derived.by(() => {
		if (form.targetType === 'existing-chat') {
			return selectedChat
				? {
						type: 'scheduled-prompt' as const,
						target: { type: 'chat' as const, chatId: selectedChat.id },
					}
				: null;
		}
		return form.startup.validationStatus === 'valid' && form.startup.executorReady
			? {
					type: 'scheduled-prompt' as const,
					target: {
						type: 'new-chat' as const,
						projectPath: form.startup.nonblankPath,
						executorId: form.startup.executorId,
					},
				}
			: null;
	});
	const knownTags = $derived(
		Array.from(new Set(sessions.orderedChats.flatMap((chat) => chat.tags))).sort(),
	);

	function createForm(): ScheduledPromptFormState {
		return new ScheduledPromptFormState(rootModelCatalog, remoteSettings, sessions, {
			executors,
			get selectableAgentIds() {
				return selectableAgentIds;
			},
		});
	}

	let form = $state(createForm());
	const modelCatalog = $derived(rootModelCatalog.forExecutor(form.startup.executorId));
	const pathContextKey = $derived(form.startup.pathContextKey);
	function selectableAgentsForExecutor(executorId: string) {
		const allAgentIds = rootModelCatalog.forExecutor(executorId).getSelectableAgents();
		return localSettings.allowDirectChats ? allAgentIds : nonDirectAgentIds(allAgentIds);
	}
	const selectableAgentIds = $derived(selectableAgentsForExecutor(form.startup.executorId));
	let pickerOpen = $state(false);
	let isMobile = $state(false);
	let initialization = 0;

	const selectedChat = $derived(
		form.existingChatId ? sessions.byId[form.existingChatId] : undefined,
	);
	const minimumDate = $derived(localDateValue(currentTime));
	const snippetContextKey = $derived(
		form.targetType === 'new-chat'
			? form.startup.pathContextKey
			: `${selectedChat?.executorId ?? 'local'}\u0000${selectedChat?.projectPath ?? ''}`,
	);
	const timezone = $derived(browserTimeZoneLabel(currentTime));
	const schedulePreview = $derived(form.schedulePreview(PREVIEW_RUN_COUNT, currentTime));
	const canSave = $derived(form.canSaveAt(currentTime));
	// A saved recurring prompt has already started, so its date and time are its next run.
	const editingRecurrence = $derived(scheduledPrompt?.schedule.type === 'recurring');
	const dateLabel = $derived.by(() => {
		if (form.scheduleType === 'once') return m.scheduled_prompts_date();
		return editingRecurrence
			? m.scheduled_prompts_next_run_date()
			: m.scheduled_prompts_first_run_date();
	});
	const timeLabel = $derived.by(() => {
		if (form.scheduleType === 'once') return m.scheduled_prompts_time();
		return editingRecurrence
			? m.scheduled_prompts_next_run_time()
			: m.scheduled_prompts_first_run_time();
	});

	$effect(() => {
		if (!open) return;
		const currentPrompt = scheduledPrompt;
		const token = ++initialization;
		untrack(() => {
			const nextForm = createForm();
			form.dispose();
			form = nextForm;
			pickerOpen = false;
			void nextForm.initialize(currentPrompt).catch((error) => {
				if (token !== initialization || form !== nextForm) return;
				nextForm.error =
					error instanceof Error ? error.message : m.scheduled_prompts_load_form_error();
			});
		});
	});

	$effect(() => {
		const activeForm = form;
		if (!open || activeForm.targetType !== 'new-chat') return;
		void activeForm.startup.nonblankPath;
		void pathContextKey;
		untrack(() => activeForm.startup.validatePath());
	});

	$effect(() => {
		if (!open || form.targetType !== 'new-chat' || !form.startup.executorReady) return;
		const catalog = modelCatalog;
		void catalog.version;
		untrack(() => void catalog.refreshIfStale());
	});

	$effect(() => {
		if (!open) return;
		void modelCatalog.version;
		form.startup.validateAllModelsAgainstLive();
	});

	$effect(() => {
		if (!open) return;
		const eligibleAgentIds = selectableAgentIds;
		const activeForm = form;
		untrack(() => activeForm.startup.reconcileAgentSelection(eligibleAgentIds));
	});

	onMount(() => {
		const media = window.matchMedia('(max-width: 768px)');
		isMobile = media.matches;
		const handleChange = (event: MediaQueryListEvent) => (isMobile = event.matches);
		media.addEventListener('change', handleChange);
		return () => media.removeEventListener('change', handleChange);
	});

	onDestroy(() => {
		initialization += 1;
		form.dispose();
	});

	async function save(): Promise<void> {
		const submittingForm = form;
		if (!submittingForm.canSave || submittingForm.saving) return;
		const definition = submittingForm.buildDefinition();
		if (!definition) return;
		submittingForm.saving = true;
		submittingForm.error = null;
		try {
			await onSave(definition);
			if (form !== submittingForm) return;
			onClose();
		} catch (error) {
			if (form !== submittingForm) return;
			submittingForm.error =
				error instanceof Error ? error.message : m.scheduled_prompts_save_error();
		} finally {
			if (form === submittingForm) submittingForm.saving = false;
		}
	}

	// Keeps sub-hour presets short enough for the four chips to share one row on a phone.
	function presetLabel(intervalMinutes: number): string {
		return intervalMinutes < 60
			? m.scheduled_prompts_preset_minutes({ count: intervalMinutes })
			: recurringCadenceLabel(intervalMinutes);
	}

	// Escape and the overlay ask to close like the buttons do, and a save in flight refuses them all.
	function requestClose(): void {
		if (!form.saving) onClose();
	}

	const sectionClass = 'space-y-3 rounded-lg border border-border bg-card p-3 sm:space-y-4 sm:p-4';
	const optionGridClass = 'grid grid-cols-2 gap-2';

	function handlePromptKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
		event.preventDefault();
		void save();
	}
</script>

<Dialog.Root {open} requestClose={requestClose}>
	<Dialog.Content
		class="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[calc(100dvh-2rem)] sm:max-h-[48rem] sm:max-w-3xl sm:rounded-lg sm:border"
		showCloseButton={false}
	>
		<ScheduledPromptHeader
			title={scheduledPrompt ? m.scheduled_prompts_edit_title() : m.scheduled_prompts_add_title()}
			description={m.scheduled_prompts_dialog_description()}
			{onClose}
			closeDisabled={form.saving}
		/>

		<div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
			<section
				class={sectionClass}
				aria-labelledby="scheduled-prompt-cadence"
			>
				<div>
					<h3 id="scheduled-prompt-cadence" class="text-sm font-medium text-foreground">
						{m.scheduled_prompts_cadence()}
					</h3>
					<p class="text-xs text-muted-foreground">
						{m.scheduled_prompts_browser_time({ timezone })}
					</p>
				</div>
				<fieldset class={optionGridClass} aria-labelledby="scheduled-prompt-cadence">
					<ScheduledPromptOption
						name="schedule-cadence"
						value="once"
						checked={form.scheduleType === 'once'}
						onSelect={() => (form.scheduleType = 'once')}
						label={m.scheduled_prompts_once()}
						description={m.scheduled_prompts_once_description()}
					/>
					<ScheduledPromptOption
						name="schedule-cadence"
						value="recurring"
						checked={form.scheduleType === 'recurring'}
						onSelect={() => (form.scheduleType = 'recurring')}
						label={m.scheduled_prompts_recurring()}
						description={m.scheduled_prompts_recurring_description()}
					/>
				</fieldset>

				{#if form.scheduleType === 'recurring'}
					<div class="space-y-2 text-sm">
						<label for="scheduled-prompt-interval" class="block font-medium">
							{m.scheduled_prompts_repeat_every()}
						</label>
						<div
							class="flex flex-wrap gap-2"
							role="group"
							aria-label={m.scheduled_prompts_interval_presets()}
						>
							{#each SCHEDULE_INTERVAL_PRESET_MINUTES as presetMinutes (presetMinutes)}
								{@const selected = form.intervalMinutes === presetMinutes}
								<button
									type="button"
									class={cn(
										'min-h-9 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
										selected
											? 'border-foreground bg-accent text-foreground'
											: 'border-border text-muted-foreground hover:bg-muted',
									)}
									aria-pressed={selected}
									title={recurringCadenceLabel(presetMinutes)}
									onclick={() => form.setIntervalMinutes(presetMinutes)}
								>
									{presetLabel(presetMinutes)}
								</button>
							{/each}
						</div>
						<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:max-w-xs">
							<input
								id="scheduled-prompt-interval"
								type="number"
								min={SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN}
								max={form.intervalAmountMax}
								step="1"
								bind:value={form.intervalAmount}
								class="h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
							/>
							<select
								aria-label={m.scheduled_prompts_interval_unit()}
								bind:value={form.intervalUnit}
								class="select-native select-native-surface h-11 pl-3 text-base sm:pointer-fine:text-sm"
							>
								<option value="minutes">{m.scheduled_prompts_minutes()}</option>
								<option value="hours">{m.scheduled_prompts_hours()}</option>
								<option value="days">{m.scheduled_prompts_days()}</option>
							</select>
						</div>
					</div>
				{/if}

				<div class="grid gap-3 sm:grid-cols-2">
					<label class="space-y-1 text-sm">
						<span class="font-medium">{dateLabel}</span>
						<input
							type="date"
							min={minimumDate}
							bind:value={form.date}
							class="h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
						/>
					</label>
					<label class="space-y-1 text-sm">
						<span class="font-medium">{timeLabel}</span>
						<input
							type="time"
							step="60"
							bind:value={form.time}
							class="h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
						/>
					</label>
				</div>

				{#if form.scheduleType === 'recurring'}
					<div class="space-y-2">
						<p class="text-sm font-medium">{m.scheduled_prompts_lifecycle()}</p>
						<fieldset
							class={optionGridClass}
							aria-label={m.scheduled_prompts_lifecycle()}
						>
							<ScheduledPromptOption
								name="recurrence-end"
								value="forever"
								checked={form.recurrenceEnd === 'forever'}
								onSelect={() => (form.recurrenceEnd = 'forever')}
								label={m.scheduled_prompts_forever()}
							/>
							<ScheduledPromptOption
								name="recurrence-end"
								value="until"
								checked={form.recurrenceEnd === 'until'}
								onSelect={() => (form.recurrenceEnd = 'until')}
								label={m.scheduled_prompts_until_label()}
							/>
						</fieldset>
						{#if form.recurrenceEnd === 'until'}
							<label class="block max-w-xs space-y-1 text-sm">
								<span class="font-medium">{m.scheduled_prompts_end_date()}</span>
								<input
									type="date"
									min={minimumDate}
									bind:value={form.endDate}
									class="h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
								/>
							</label>
						{/if}
					</div>
				{/if}
				<ScheduledPromptSchedulePreview
					preview={schedulePreview}
					{currentTime}
					recurring={form.scheduleType === 'recurring'}
					cadence={form.scheduleType === 'recurring'
						? recurringCadenceLabel(form.intervalMinutes)
						: m.scheduled_prompts_once()}
				/>
			</section>

			<section
				class={sectionClass}
				aria-labelledby="scheduled-prompt-target"
			>
				<h3 id="scheduled-prompt-target" class="text-sm font-medium text-foreground">
					{m.scheduled_prompts_chat_target()}
				</h3>
				<fieldset class={optionGridClass} aria-labelledby="scheduled-prompt-target">
					<ScheduledPromptOption
						name="chat-target"
						value="new-chat"
						checked={form.targetType === 'new-chat'}
						onSelect={() => (form.targetType = 'new-chat')}
						label={m.scheduled_prompts_new_chat()}
						description={m.scheduled_prompts_new_chat_description()}
					/>
					<ScheduledPromptOption
						name="chat-target"
						value="existing-chat"
						checked={form.targetType === 'existing-chat'}
						onSelect={() => (form.targetType = 'existing-chat')}
						label={m.scheduled_prompts_existing_chat()}
						description={m.scheduled_prompts_existing_chat_description()}
					/>
				</fieldset>

				{#if form.targetType === 'new-chat'}
					<ScheduledNewChatComposer
						startup={form.startup}
						{modelCatalog}
						{remoteSettings}
						getSelectableAgentIds={selectableAgentsForExecutor}
						prompt={form.prompt}
						promptError={form.promptError}
						{knownTags}
						{isMobile}
						onPromptChange={(value) => (form.prompt = value)}
						onPromptKeydown={handlePromptKeydown}
						{snippetContext}
						{snippetContextKey}
						snippetTrigger={localSettings.snippetTrigger}
						onSnippetPendingChange={(pending) => (form.promptTransformPending = pending)}
					/>
				{:else}
					<div class="space-y-3 rounded-md border border-border p-3">
						<div class="flex min-w-0 flex-wrap items-center gap-3">
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">
									{selectedChat?.title ?? m.scheduled_prompts_no_chat_selected()}
								</p>
								{#if selectedChat}
									<p class="truncate text-xs text-muted-foreground">{selectedChat.projectPath}</p>
								{:else if form.existingChatId}
									<p class="truncate text-xs text-destructive">
										{m.scheduled_prompts_selected_chat_missing({ id: form.existingChatId })}
									</p>
								{/if}
							</div>
							<Button variant="secondary" onclick={() => (pickerOpen = true)}>
								<Search class="mr-2 h-4 w-4" />
								{m.scheduled_prompts_select_chat()}
							</Button>
						</div>
						<fieldset class="grid gap-2 sm:grid-cols-2">
							<legend class="mb-2 text-sm font-medium">{m.scheduled_prompts_when_busy()}</legend>
							<ScheduledPromptOption
								name="busy-behavior"
								value="queue"
								checked={form.busyBehavior === 'queue'}
								onSelect={() => (form.busyBehavior = 'queue')}
								label={m.scheduled_prompts_queue_message()}
								description={m.scheduled_prompts_queue_message_description()}
							/>
							<ScheduledPromptOption
								name="busy-behavior"
								value="skip"
								checked={form.busyBehavior === 'skip'}
								onSelect={() => (form.busyBehavior = 'skip')}
								label={m.scheduled_prompts_skip_sending()}
								description={m.scheduled_prompts_skip_sending_description()}
							/>
						</fieldset>
					</div>
				{/if}
			</section>

			{#if form.targetType === 'existing-chat'}
				<ScheduledPromptField
					prompt={form.prompt}
					promptError={form.promptError}
					targetType="existing-chat"
					surface="standalone"
					onPromptChange={(value) => (form.prompt = value)}
					onPromptKeydown={handlePromptKeydown}
					{snippetContext}
					{snippetContextKey}
					snippetTrigger={localSettings.snippetTrigger}
					onSnippetPendingChange={(pending) => (form.promptTransformPending = pending)}
					onEditSnippets={(returnFocus) => appShell.openSnippetsOverScheduledPrompts(returnFocus)}
				/>
			{/if}

			{#if form.error}
				<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{form.error}
				</p>
			{/if}
		</div>

		<Dialog.Footer class="shrink-0 border-t border-border bg-background px-4 py-3 sm:px-6 sm:py-4">
			<Button variant="secondary" onclick={onClose} disabled={form.saving}>
				{m.scheduled_prompts_cancel()}
			</Button>
			<Button onclick={() => void save()} disabled={!canSave}>
				{form.saving ? m.scheduled_prompts_saving() : m.scheduled_prompts_save()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ScheduledChatPickerDialog
	open={pickerOpen}
	onSelect={(chatId) => (form.existingChatId = chatId)}
	onClose={() => (pickerOpen = false)}
/>
