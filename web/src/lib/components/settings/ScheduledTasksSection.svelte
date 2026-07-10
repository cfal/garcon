<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { getChatSessions, getScheduledTasks } from '$lib/context';
	import type { ScheduledTask, ScheduledTaskDefinitionInput } from '$shared/scheduled-tasks';
	import ScheduledTaskDialog from './ScheduledTaskDialog.svelte';
	import ScheduledTaskRemoveDialog from './ScheduledTaskRemoveDialog.svelte';
	import ScheduledTaskRow from './ScheduledTaskRow.svelte';
	import ScheduledTaskRunLogDialog from './ScheduledTaskRunLogDialog.svelte';
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
	const tasks = getScheduledTasks();
	const sessions = getChatSessions();
	let formOpen = $state(false);
	let editingTask = $state<ScheduledTask | null>(null);
	let removeTask = $state<ScheduledTask | null>(null);
	let removing = $state(false);
	let removeError = $state<string | null>(null);
	let runLogOpen = $state(false);
	let movingTaskId = $state<string | null>(null);
	let operationError = $state<string | null>(null);
	let currentTime = $state(new Date());

	$effect(() => {
		if (!active) return;
		void tasks.ensureLoaded().catch(() => {});
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
		editingTask = null;
		operationError = null;
		formOpen = true;
	}

	function openEdit(task: ScheduledTask): void {
		editingTask = task;
		operationError = null;
		formOpen = true;
	}

	async function save(definition: ScheduledTaskDefinitionInput): Promise<void> {
		if (editingTask) await tasks.update(editingTask.id, definition);
		else await tasks.create(definition);
	}

	async function confirmRemove(): Promise<void> {
		if (!removeTask || removing) return;
		removing = true;
		removeError = null;
		try {
			await tasks.remove(removeTask.id);
			removeTask = null;
		} catch (error) {
			removeError = error instanceof Error ? error.message : m.scheduled_tasks_remove_error();
		} finally {
			removing = false;
		}
	}

	async function move(task: ScheduledTask, direction: 'up' | 'down'): Promise<void> {
		if (movingTaskId) return;
		movingTaskId = task.id;
		operationError = null;
		try {
			await tasks.move(task.id, direction);
		} catch (error) {
			operationError = error instanceof Error ? error.message : m.scheduled_tasks_reorder_error();
		} finally {
			movingTaskId = null;
		}
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<Button onclick={openCreate} disabled={!tasks.hasLoaded}>
				<Plus class="mr-2 h-4 w-4" />
				{m.scheduled_tasks_add_task()}
			</Button>
			<Button variant="secondary" onclick={() => (runLogOpen = true)} disabled={!tasks.hasLoaded}>
				<ScrollText class="mr-2 h-4 w-4" />
				{m.scheduled_tasks_run_log()}
			</Button>
		</div>
		{#if tasks.hasLoaded}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => void tasks.refresh().catch(() => {})}
				disabled={tasks.isRefreshing}
				title={m.scheduled_tasks_refresh()}
				aria-label={m.scheduled_tasks_refresh()}
			>
				<RefreshCw class={tasks.isRefreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
			</Button>
		{/if}
	</div>

	{#if operationError}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{operationError}
		</p>
	{/if}
	{#if tasks.hasLoaded && tasks.error}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{tasks.error}
		</p>
	{/if}

	{#if tasks.status === 'loading' || tasks.status === 'idle'}
		<div class="flex min-h-48 items-center justify-center text-muted-foreground" role="status">
			<Loader2 class="mr-2 h-5 w-5 animate-spin" />
			{m.scheduled_tasks_loading()}
		</div>
	{:else if tasks.status === 'error' && !tasks.hasLoaded}
		<div class="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
			<CircleAlert class="h-6 w-6 text-destructive" />
			<p class="max-w-md text-sm text-muted-foreground">
				{tasks.error ?? m.scheduled_tasks_load_error()}
			</p>
			<Button variant="secondary" onclick={() => void tasks.ensureLoaded().catch(() => {})}>
				{m.scheduled_tasks_retry()}
			</Button>
		</div>
	{:else if tasks.tasks.length === 0}
		<div class="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
			<ClipboardClock class="h-7 w-7 text-muted-foreground" />
			<p class="text-sm font-medium text-foreground">{m.scheduled_tasks_empty()}</p>
			<p class="max-w-md text-xs text-muted-foreground">
				{m.scheduled_tasks_empty_description()}
			</p>
		</div>
	{:else}
		<div class="space-y-2" aria-live="polite">
			{#each tasks.tasks as task, index (task.id)}
				<svelte:boundary>
					<ScheduledTaskRow
						{task}
						{index}
						{currentTime}
						total={tasks.tasks.length}
						existingChat={task.target.type === 'existing-chat'
							? sessions.byId[task.target.chatId]
							: undefined}
						disabled={movingTaskId !== null}
						onEdit={() => openEdit(task)}
						onRemove={() => {
							removeError = null;
							removeTask = task;
						}}
						onMoveUp={() => void move(task, 'up')}
						onMoveDown={() => void move(task, 'down')}
					/>
					{#snippet failed()}
						<div class="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
							{m.scheduled_tasks_row_error()}
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
	{/if}
</div>

<ScheduledTaskDialog
	open={formOpen}
	task={editingTask}
	onSave={save}
	onClose={() => (formOpen = false)}
/>
<ScheduledTaskRemoveDialog
	open={removeTask !== null}
	task={removeTask}
	{removing}
	error={removeError}
	onConfirm={() => void confirmRemove()}
	onClose={() => (removeTask = null)}
/>
<ScheduledTaskRunLogDialog
	open={runLogOpen}
	entries={tasks.runLog}
	onClose={() => (runLogOpen = false)}
/>
