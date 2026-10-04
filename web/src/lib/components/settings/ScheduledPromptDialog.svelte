<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import ScheduledChatPickerDialog from './ScheduledChatPickerDialog.svelte';
	import ScheduledNewChatComposer from './ScheduledNewChatComposer.svelte';
	import ScheduledPromptField from './ScheduledPromptField.svelte';
	import ScheduledPromptOption from './ScheduledPromptOption.svelte';
	import { ScheduledPromptFormState } from './scheduled-prompt-form-state.svelte';
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
	import {
		SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN,
		type ScheduledPrompt,
		type ScheduledPromptDefinitionInput,
	} from '$shared/scheduled-prompts';
	import Search from '@lucide/svelte/icons/search';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		scheduledPrompt: ScheduledPrompt | null;
		onSave: (definition: ScheduledPromptDefinitionInput) => Promise<void>;
		onClose: () => void;
	}

	let { open, scheduledPrompt, onSave, onClose }: Props = $props();
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
	const minimumDate = $derived(localDateValue(new Date()));
	const snippetContextKey = $derived(
		form.targetType === 'new-chat'
			? form.startup.pathContextKey
			: `${selectedChat?.executorId ?? 'local'}\u0000${selectedChat?.projectPath ?? ''}`,
	);
	const timezone = $derived(browserTimeZoneLabel());

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

	function handlePromptKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
		event.preventDefault();
		void save();
	}
</script>

<Dialog.Root {open} onOpenChange={(value) => !value && !form.saving && onClose()}>
	<Dialog.Content
		class="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[calc(100dvh-2rem)] sm:max-h-[48rem] sm:max-w-3xl sm:rounded-lg sm:border"
		showCloseButton={false}
	>
		<Dialog.Header class="shrink-0 border-b border-border bg-background px-5 py-4 sm:px-6">
			<Dialog.Title>
				{scheduledPrompt ? m.scheduled_prompts_edit_title() : m.scheduled_prompts_add_title()}
			</Dialog.Title>
			<Dialog.Description>{m.scheduled_prompts_dialog_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
			<section
				class="space-y-4 rounded-lg border border-border bg-card p-4"
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
				<fieldset class="grid gap-2 sm:grid-cols-2" aria-labelledby="scheduled-prompt-cadence">
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

				{#if form.scheduleType === 'once'}
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="space-y-1 text-sm">
							<span class="font-medium">{m.scheduled_prompts_date()}</span>
							<input
								type="date"
								min={minimumDate}
								bind:value={form.date}
								class="h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
							/>
						</label>
						<label class="space-y-1 text-sm">
							<span class="font-medium">{m.scheduled_prompts_time()}</span>
							<input
								type="time"
								step="60"
								bind:value={form.time}
								class="h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
							/>
						</label>
					</div>
				{:else}
					<div class="grid gap-3 sm:grid-cols-2">
						<div class="space-y-1 text-sm">
							<label for="scheduled-prompt-interval" class="font-medium">
								{m.scheduled_prompts_repeat_every()}
							</label>
							<div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
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
									class="select-native select-native-surface h-10 pl-3 text-base sm:pointer-fine:text-sm"
								>
									<option value="minutes">{m.scheduled_prompts_minutes()}</option>
									<option value="hours">{m.scheduled_prompts_hours()}</option>
									<option value="days">{m.scheduled_prompts_days()}</option>
								</select>
							</div>
						</div>
						<label class="space-y-1 text-sm">
							<span class="font-medium">{m.scheduled_prompts_first_run_time()}</span>
							<input
								type="time"
								step="60"
								bind:value={form.time}
								class="h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
							/>
						</label>
					</div>
					<div class="space-y-2">
						<p class="text-sm font-medium">{m.scheduled_prompts_lifecycle()}</p>
						<fieldset
							class="grid gap-2 sm:grid-cols-2"
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
				{#if !form.scheduleValid}
					<p class="text-xs text-destructive">{m.scheduled_prompts_schedule_error()}</p>
				{/if}
			</section>

			<section
				class="space-y-4 rounded-lg border border-border bg-card p-4"
				aria-labelledby="scheduled-prompt-target"
			>
				<h3 id="scheduled-prompt-target" class="text-sm font-medium text-foreground">
					{m.scheduled_prompts_chat_target()}
				</h3>
				<fieldset class="grid gap-2 sm:grid-cols-2" aria-labelledby="scheduled-prompt-target">
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

		<Dialog.Footer class="shrink-0 border-t border-border bg-background px-5 py-4 sm:px-6">
			<Button variant="secondary" onclick={onClose} disabled={form.saving}>
				{m.scheduled_prompts_cancel()}
			</Button>
			<Button onclick={() => void save()} disabled={!form.canSave}>
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
