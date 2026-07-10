<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { formatScheduledInstant } from '$lib/scheduling/local-schedule';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ScheduledTask } from '$shared/scheduled-tasks';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		task: ScheduledTask;
		index: number;
		total: number;
		existingChat?: ChatSessionRecord;
		disabled?: boolean;
		onEdit: () => void;
		onRemove: () => void;
		onMoveUp: () => void;
		onMoveDown: () => void;
	}

	let {
		task,
		index,
		total,
		existingChat,
		disabled = false,
		onEdit,
		onRemove,
		onMoveUp,
		onMoveDown,
	}: Props = $props();

	let title = $derived(task.prompt.split(/\r?\n/, 1)[0]?.trim() || m.scheduled_tasks_untitled());
	let cadence = $derived.by(() => {
		if (task.schedule.type === 'once') return m.scheduled_tasks_once();
		const interval = task.schedule.intervalDays;
		const base =
			interval === 1
				? m.scheduled_tasks_daily()
				: m.scheduled_tasks_every_days({ count: interval });
		return task.schedule.endAt
			? `${base}, ${m.scheduled_tasks_until({ date: formatScheduledInstant(task.schedule.endAt) })}`
			: `${base}, ${m.scheduled_tasks_forever().toLowerCase()}`;
	});
	let target = $derived.by(() => {
		if (task.target.type === 'new-chat') {
			return m.scheduled_tasks_new_chat_target({ path: task.target.projectPath });
		}
		return existingChat?.title
			? m.scheduled_tasks_existing_chat_target({ title: existingChat.title })
			: m.scheduled_tasks_missing_chat_target({ id: task.target.chatId });
	});
</script>

<article class="rounded-md border border-border bg-card p-3">
	<div class="flex min-w-0 items-start gap-3">
		<div class="min-w-0 flex-1 space-y-1">
			<h3 class="truncate text-sm font-medium text-foreground" {title}>{title}</h3>
			<p class="text-xs text-muted-foreground">
				{formatScheduledInstant(task.schedule.nextRunAt)} - {cadence}
			</p>
			<p class="truncate text-xs text-muted-foreground" title={target}>{target}</p>
		</div>
		<div class="grid shrink-0 grid-cols-2 gap-1 sm:flex">
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveUp}
				disabled={disabled || index === 0}
				title={m.scheduled_tasks_move_up()}
				aria-label={m.scheduled_tasks_move_up()}
			>
				<ArrowUp class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveDown}
				disabled={disabled || index === total - 1}
				title={m.scheduled_tasks_move_down()}
				aria-label={m.scheduled_tasks_move_down()}
			>
				<ArrowDown class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onEdit}
				{disabled}
				title={m.scheduled_tasks_edit()}
				aria-label={m.scheduled_tasks_edit()}
			>
				<Pencil class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-destructive hover:text-destructive"
				onclick={onRemove}
				{disabled}
				title={m.scheduled_tasks_remove()}
				aria-label={m.scheduled_tasks_remove()}
			>
				<Trash2 class="h-4 w-4" />
			</Button>
		</div>
	</div>
</article>
