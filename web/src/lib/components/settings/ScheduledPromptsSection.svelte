<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { getChatSessions, getScheduledPrompts } from '$lib/context';
	import type { ScheduledPrompt, ScheduledPromptDefinitionInput } from '$shared/scheduled-prompts';
	import ScheduledPromptDialog from './ScheduledPromptDialog.svelte';
	import ScheduledPromptRemoveDialog from './ScheduledPromptRemoveDialog.svelte';
	import ScheduledPromptRow from './ScheduledPromptRow.svelte';
	import ScheduledPromptRunLogDialog from './ScheduledPromptRunLogDialog.svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import ClipboardClock from '@lucide/svelte/icons/clipboard-clock';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import * as m from '$lib/paraglide/messages.js';

	const MINUTE_MS = 60_000;

	interface Props {
		active: boolean;
	}

	let { active }: Props = $props();
	const prompts = getScheduledPrompts();
	const sessions = getChatSessions();
	let formOpen = $state(false);
	let editingPrompt = $state<ScheduledPrompt | null>(null);
	let removePrompt = $state<ScheduledPrompt | null>(null);
	let removing = $state(false);
	let removeError = $state<string | null>(null);
	let runLogOpen = $state(false);
	let movingPromptId = $state<string | null>(null);
	let operationError = $state<string | null>(null);
	let currentTime = $state(new Date());

	$effect(() => {
		if (!active) return;
		void prompts.ensureLoaded().catch(() => {});
	});

	$effect(() => {
		if (!active) return;
		let intervalId: ReturnType<typeof setInterval> | null = null;

		const refreshCurrentTime = () => {
			currentTime = new Date();
		};
		const elapsedInMinute = Date.now() % MINUTE_MS;
		const timeoutId = setTimeout(
			() => {
				refreshCurrentTime();
				intervalId = setInterval(refreshCurrentTime, MINUTE_MS);
			},
			elapsedInMinute === 0 ? MINUTE_MS : MINUTE_MS - elapsedInMinute,
		);
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') refreshCurrentTime();
		};

		refreshCurrentTime();
		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			clearTimeout(timeoutId);
			if (intervalId !== null) clearInterval(intervalId);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});

	function openCreate(): void {
		editingPrompt = null;
		operationError = null;
		formOpen = true;
	}

	function openEdit(scheduledPrompt: ScheduledPrompt): void {
		editingPrompt = scheduledPrompt;
		operationError = null;
		formOpen = true;
	}

	async function save(definition: ScheduledPromptDefinitionInput): Promise<void> {
		if (editingPrompt) await prompts.update(editingPrompt.id, definition);
		else await prompts.create(definition);
	}

	async function confirmRemove(): Promise<void> {
		if (!removePrompt || removing) return;
		removing = true;
		removeError = null;
		try {
			await prompts.remove(removePrompt.id);
			removePrompt = null;
		} catch (error) {
			removeError = error instanceof Error ? error.message : m.scheduled_prompts_remove_error();
		} finally {
			removing = false;
		}
	}

	async function move(scheduledPrompt: ScheduledPrompt, direction: 'up' | 'down'): Promise<void> {
		if (movingPromptId) return;
		movingPromptId = scheduledPrompt.id;
		operationError = null;
		try {
			await prompts.move(scheduledPrompt.id, direction);
		} catch (error) {
			operationError = error instanceof Error ? error.message : m.scheduled_prompts_reorder_error();
		} finally {
			movingPromptId = null;
		}
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<Button onclick={openCreate} disabled={!prompts.hasLoaded}>
				<Plus class="mr-2 h-4 w-4" />
				{m.scheduled_prompts_add_prompt()}
			</Button>
			<Button variant="secondary" onclick={() => (runLogOpen = true)} disabled={!prompts.hasLoaded}>
				<ScrollText class="mr-2 h-4 w-4" />
				{m.scheduled_prompts_run_log()}
			</Button>
		</div>
		{#if prompts.hasLoaded}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => void prompts.refresh().catch(() => {})}
				disabled={prompts.isRefreshing}
				title={m.scheduled_prompts_refresh()}
				aria-label={m.scheduled_prompts_refresh()}
			>
				<RefreshCw class={prompts.isRefreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
			</Button>
		{/if}
	</div>

	{#if operationError}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{operationError}
		</p>
	{/if}
	{#if prompts.hasLoaded && prompts.error}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{prompts.error}
		</p>
	{/if}

	{#if prompts.status === 'loading' || prompts.status === 'idle'}
		<div class="flex min-h-48 items-center justify-center text-muted-foreground" role="status">
			<Loader2 class="mr-2 h-5 w-5 animate-spin" />
			{m.scheduled_prompts_loading()}
		</div>
	{:else if prompts.status === 'error' && !prompts.hasLoaded}
		<div class="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
			<CircleAlert class="h-6 w-6 text-destructive" />
			<p class="max-w-md text-sm text-muted-foreground">
				{prompts.error ?? m.scheduled_prompts_load_error()}
			</p>
			<Button variant="secondary" onclick={() => void prompts.ensureLoaded().catch(() => {})}>
				{m.scheduled_prompts_retry()}
			</Button>
		</div>
	{:else if prompts.prompts.length === 0}
		<div class="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
			<ClipboardClock class="h-7 w-7 text-muted-foreground" />
			<p class="text-sm font-medium text-foreground">{m.scheduled_prompts_empty()}</p>
			<p class="max-w-md text-xs text-muted-foreground">
				{m.scheduled_prompts_empty_description()}
			</p>
		</div>
	{:else}
		<div class="space-y-2" aria-live="polite">
			{#each prompts.prompts as scheduledPrompt, index (scheduledPrompt.id)}
				<svelte:boundary>
					<ScheduledPromptRow
						{scheduledPrompt}
						{index}
						{currentTime}
						total={prompts.prompts.length}
						existingChat={scheduledPrompt.target.type === 'existing-chat'
							? sessions.byId[scheduledPrompt.target.chatId]
							: undefined}
						disabled={movingPromptId !== null}
						onEdit={() => openEdit(scheduledPrompt)}
						onRemove={() => {
							removeError = null;
							removePrompt = scheduledPrompt;
						}}
						onMoveUp={() => void move(scheduledPrompt, 'up')}
						onMoveDown={() => void move(scheduledPrompt, 'down')}
					/>
					{#snippet failed()}
						<div class="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
							{m.scheduled_prompts_row_error()}
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
	{/if}
</div>

<ScheduledPromptDialog
	open={formOpen}
	scheduledPrompt={editingPrompt}
	onSave={save}
	onClose={() => (formOpen = false)}
/>
<ScheduledPromptRemoveDialog
	open={removePrompt !== null}
	scheduledPrompt={removePrompt}
	{removing}
	error={removeError}
	onConfirm={() => void confirmRemove()}
	onClose={() => (removePrompt = null)}
/>
<ScheduledPromptRunLogDialog
	open={runLogOpen}
	entries={prompts.runLog}
	onClose={() => (runLogOpen = false)}
/>
