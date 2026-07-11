<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import ScheduledChatPickerDialog from './ScheduledChatPickerDialog.svelte';
	import ScheduledNewChatComposer from './ScheduledNewChatComposer.svelte';
	import { ScheduledTaskFormState } from './scheduled-task-form-state.svelte';
	import { getChatSessions, getModelCatalog, getRemoteSettings } from '$lib/context';
	import { browserTimeZoneLabel, localDateValue } from '$lib/scheduling/local-schedule';
	import {
		SCHEDULED_TASK_INTERVAL_DAYS_MAX,
		SCHEDULED_TASK_INTERVAL_DAYS_MIN,
		type ScheduledTask,
		type ScheduledTaskDefinitionInput,
	} from '$shared/scheduled-tasks';
	import Search from '@lucide/svelte/icons/search';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		task: ScheduledTask | null;
		onSave: (definition: ScheduledTaskDefinitionInput) => Promise<void>;
		onClose: () => void;
	}

	let { open, task, onSave, onClose }: Props = $props();
	const modelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const sessions = getChatSessions();
	let form = $state(new ScheduledTaskFormState(modelCatalog, remoteSettings, sessions));
	let pickerOpen = $state(false);
	let isMobile = $state(false);
	let initialization = 0;

	const selectedChat = $derived(
		form.existingChatId ? sessions.byId[form.existingChatId] : undefined,
	);
	const minimumDate = $derived(localDateValue(new Date()));
	const timezone = $derived(browserTimeZoneLabel());

	$effect(() => {
		if (!open) return;
		const currentTask = task;
		const token = ++initialization;
		const nextForm = new ScheduledTaskFormState(modelCatalog, remoteSettings, sessions);
		form = nextForm;
		pickerOpen = false;
		untrack(() => {
			void nextForm.initialize(currentTask).catch((error) => {
				if (token !== initialization || form !== nextForm) return;
				nextForm.error =
					error instanceof Error ? error.message : m.scheduled_tasks_load_form_error();
			});
		});
	});

	$effect(() => {
		if (!open || form.targetType !== 'new-chat') return;
		void form.startup.trimmedPath;
		form.startup.validatePath();
	});

	$effect(() => {
		if (!open) return;
		void modelCatalog.version;
		form.startup.validateAllModelsAgainstLive();
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
	});

	async function save(): Promise<void> {
		if (!form.canSave || form.saving) return;
		const definition = form.buildDefinition();
		if (!definition) return;
		form.saving = true;
		form.error = null;
		try {
			await onSave(definition);
			onClose();
		} catch (error) {
			form.error = error instanceof Error ? error.message : m.scheduled_tasks_save_error();
		} finally {
			form.saving = false;
		}
	}

	function handlePromptKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
		if (!form.canSave) return;
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
				{task ? m.scheduled_tasks_edit_title() : m.scheduled_tasks_add_title()}
			</Dialog.Title>
			<Dialog.Description>{m.scheduled_tasks_dialog_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
			<section class="space-y-3" aria-labelledby="scheduled-task-cadence">
				<div>
					<h3 id="scheduled-task-cadence" class="text-sm font-medium text-foreground">
						{m.scheduled_tasks_cadence()}
					</h3>
					<p class="text-xs text-muted-foreground">
						{m.scheduled_tasks_browser_time({ timezone })}
					</p>
				</div>
				<div class="grid gap-2 sm:grid-cols-2">
					<label class="flex cursor-pointer gap-3 rounded-md border border-border p-3">
						<input
							type="radio"
							name="schedule-cadence"
							value="once"
							bind:group={form.scheduleType}
						/>
						<span>
							<span class="block text-sm font-medium">{m.scheduled_tasks_once()}</span>
							<span class="block text-xs text-muted-foreground">
								{m.scheduled_tasks_once_description()}
							</span>
						</span>
					</label>
					<label class="flex cursor-pointer gap-3 rounded-md border border-border p-3">
						<input
							type="radio"
							name="schedule-cadence"
							value="recurring"
							bind:group={form.scheduleType}
						/>
						<span>
							<span class="block text-sm font-medium">{m.scheduled_tasks_recurring()}</span>
							<span class="block text-xs text-muted-foreground">
								{m.scheduled_tasks_recurring_description()}
							</span>
						</span>
					</label>
				</div>

				{#if form.scheduleType === 'once'}
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="space-y-1 text-sm">
							<span class="font-medium">{m.scheduled_tasks_date()}</span>
							<input
								type="date"
								min={minimumDate}
								bind:value={form.date}
								class="h-10 w-full rounded-md border border-border bg-background px-3"
							/>
						</label>
						<label class="space-y-1 text-sm">
							<span class="font-medium">{m.scheduled_tasks_time()}</span>
							<input
								type="time"
								step="60"
								bind:value={form.time}
								class="h-10 w-full rounded-md border border-border bg-background px-3"
							/>
						</label>
					</div>
				{:else}
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="space-y-1 text-sm">
							<span class="font-medium">{m.scheduled_tasks_every_n_days()}</span>
							<input
								type="number"
								min={SCHEDULED_TASK_INTERVAL_DAYS_MIN}
								max={SCHEDULED_TASK_INTERVAL_DAYS_MAX}
								step="1"
								bind:value={form.intervalDays}
								class="h-10 w-full rounded-md border border-border bg-background px-3"
							/>
						</label>
						<label class="space-y-1 text-sm">
							<span class="font-medium">{m.scheduled_tasks_time()}</span>
							<input
								type="time"
								step="60"
								bind:value={form.time}
								class="h-10 w-full rounded-md border border-border bg-background px-3"
							/>
						</label>
					</div>
					<div class="space-y-2">
						<p class="text-sm font-medium">{m.scheduled_tasks_lifecycle()}</p>
						<div class="flex flex-wrap gap-4">
							<label class="flex items-center gap-2 text-sm">
								<input
									type="radio"
									name="recurrence-end"
									value="forever"
									bind:group={form.recurrenceEnd}
								/>
								{m.scheduled_tasks_forever()}
							</label>
							<label class="flex items-center gap-2 text-sm">
								<input
									type="radio"
									name="recurrence-end"
									value="until"
									bind:group={form.recurrenceEnd}
								/>
								{m.scheduled_tasks_until_label()}
							</label>
						</div>
						{#if form.recurrenceEnd === 'until'}
							<label class="block max-w-xs space-y-1 text-sm">
								<span class="font-medium">{m.scheduled_tasks_end_date()}</span>
								<input
									type="date"
									min={minimumDate}
									bind:value={form.endDate}
									class="h-10 w-full rounded-md border border-border bg-background px-3"
								/>
							</label>
						{/if}
					</div>
				{/if}
				{#if !form.scheduleValid}
					<p class="text-xs text-destructive">{m.scheduled_tasks_schedule_error()}</p>
				{/if}
			</section>

			<section class="space-y-3" aria-labelledby="scheduled-task-target">
				<h3 id="scheduled-task-target" class="text-sm font-medium text-foreground">
					{m.scheduled_tasks_chat_target()}
				</h3>
				<div class="grid gap-2 sm:grid-cols-2">
					<label class="flex cursor-pointer gap-3 rounded-md border border-border p-3">
						<input type="radio" name="chat-target" value="new-chat" bind:group={form.targetType} />
						<span>
							<span class="block text-sm font-medium">{m.scheduled_tasks_new_chat()}</span>
							<span class="block text-xs text-muted-foreground">
								{m.scheduled_tasks_new_chat_description()}
							</span>
						</span>
					</label>
					<label class="flex cursor-pointer gap-3 rounded-md border border-border p-3">
						<input
							type="radio"
							name="chat-target"
							value="existing-chat"
							bind:group={form.targetType}
						/>
						<span>
							<span class="block text-sm font-medium">{m.scheduled_tasks_existing_chat()}</span>
							<span class="block text-xs text-muted-foreground">
								{m.scheduled_tasks_existing_chat_description()}
							</span>
						</span>
					</label>
				</div>

				{#if form.targetType === 'new-chat'}
					<ScheduledNewChatComposer
						startup={form.startup}
						{modelCatalog}
						{remoteSettings}
						prompt={form.prompt}
						promptError={form.promptError}
						{isMobile}
						onPromptChange={(value) => (form.prompt = value)}
						onPromptKeydown={handlePromptKeydown}
					/>
				{:else}
					<div class="space-y-3 rounded-md border border-border p-3">
						<div class="flex min-w-0 items-center gap-3">
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">
									{selectedChat?.title ?? m.scheduled_tasks_no_chat_selected()}
								</p>
								{#if selectedChat}
									<p class="truncate text-xs text-muted-foreground">{selectedChat.projectPath}</p>
								{:else if form.existingChatId}
									<p class="truncate text-xs text-destructive">
										{m.scheduled_tasks_selected_chat_missing({ id: form.existingChatId })}
									</p>
								{/if}
							</div>
							<Button variant="secondary" onclick={() => (pickerOpen = true)}>
								<Search class="mr-2 h-4 w-4" />
								{m.scheduled_tasks_select_chat()}
							</Button>
						</div>
						<fieldset class="space-y-2">
							<legend class="text-sm font-medium">{m.scheduled_tasks_when_busy()}</legend>
							<label class="flex items-start gap-2 text-sm">
								<input
									type="radio"
									name="busy-behavior"
									value="queue"
									bind:group={form.busyBehavior}
								/>
								<span>
									<span class="block font-medium">{m.scheduled_tasks_queue_message()}</span>
									<span class="block text-xs text-muted-foreground">
										{m.scheduled_tasks_queue_message_description()}
									</span>
								</span>
							</label>
							<label class="flex items-start gap-2 text-sm">
								<input
									type="radio"
									name="busy-behavior"
									value="skip"
									bind:group={form.busyBehavior}
								/>
								<span>
									<span class="block font-medium">{m.scheduled_tasks_skip_sending()}</span>
									<span class="block text-xs text-muted-foreground">
										{m.scheduled_tasks_skip_sending_description()}
									</span>
								</span>
							</label>
						</fieldset>
					</div>
				{/if}
			</section>

			{#if form.targetType === 'existing-chat'}
				<section class="space-y-2" aria-labelledby="scheduled-task-prompt">
					<div>
						<label
							id="scheduled-task-prompt"
							for="scheduled-task-prompt-input"
							class="text-sm font-medium"
						>
							{m.scheduled_tasks_prompt()}
						</label>
						<p class="text-xs text-muted-foreground">{m.scheduled_tasks_prompt_description()}</p>
					</div>
					<textarea
						id="scheduled-task-prompt-input"
						bind:value={form.prompt}
						onkeydown={handlePromptKeydown}
						rows="5"
						placeholder={m.scheduled_tasks_prompt_placeholder()}
						class="block min-h-32 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-base leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
					></textarea>
					{#if form.prompt.length > 0 && form.promptError}
						<p class="text-xs text-destructive">{form.promptError}</p>
					{/if}
				</section>
			{/if}

			{#if form.error}
				<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{form.error}
				</p>
			{/if}
		</div>

		<Dialog.Footer class="shrink-0 border-t border-border bg-background px-5 py-4 sm:px-6">
			<Button variant="secondary" onclick={onClose} disabled={form.saving}>
				{m.scheduled_tasks_cancel()}
			</Button>
			<Button onclick={() => void save()} disabled={!form.canSave}>
				{form.saving ? m.scheduled_tasks_saving() : m.scheduled_tasks_save()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ScheduledChatPickerDialog
	open={pickerOpen}
	onSelect={(chatId) => (form.existingChatId = chatId)}
	onClose={() => (pickerOpen = false)}
/>
