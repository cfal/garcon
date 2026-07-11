<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import ChatAgentTags from '$lib/components/shared/ChatAgentTags.svelte';
	import { formatCompactTimeUntil, formatScheduledInstant } from '$lib/scheduling/local-schedule';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ScheduledPrompt } from '$shared/scheduled-prompts';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		scheduledPrompt: ScheduledPrompt;
		index: number;
		total: number;
		existingChat?: ChatSessionRecord;
		currentTime: Date;
		disabled?: boolean;
		onEdit: () => void;
		onRemove: () => void;
		onMoveUp: () => void;
		onMoveDown: () => void;
	}

	let {
		scheduledPrompt,
		index,
		total,
		existingChat,
		currentTime,
		disabled = false,
		onEdit,
		onRemove,
		onMoveUp,
		onMoveDown,
	}: Props = $props();

	let title = $derived(
		scheduledPrompt.prompt.split(/\r?\n/, 1)[0]?.trim() || m.scheduled_prompts_untitled(),
	);
	let timeUntilRun = $derived(
		formatCompactTimeUntil(scheduledPrompt.schedule.nextRunAt, currentTime),
	);
	let relativeRunLabel = $derived.by(() => {
		if (scheduledPrompt.schedule.type === 'once') {
			return timeUntilRun
				? m.scheduled_prompts_runs_in({ duration: timeUntilRun })
				: m.scheduled_prompts_due_now();
		}
		return timeUntilRun
			? m.scheduled_prompts_next_run_in({ duration: timeUntilRun })
			: m.scheduled_prompts_next_run_due_now();
	});
	let cadence = $derived.by(() => {
		if (scheduledPrompt.schedule.type === 'once') return m.scheduled_prompts_once();
		const interval = scheduledPrompt.schedule.intervalDays;
		const base =
			interval === 1
				? m.scheduled_prompts_daily()
				: m.scheduled_prompts_every_days({ count: interval });
		return scheduledPrompt.schedule.endAt
			? `${base}, ${m.scheduled_prompts_until({ date: formatScheduledInstant(scheduledPrompt.schedule.endAt) })}`
			: `${base}, ${m.scheduled_prompts_forever().toLowerCase()}`;
	});
	let target = $derived.by(() => {
		if (scheduledPrompt.target.type === 'new-chat') {
			return m.scheduled_prompts_new_chat_target({ path: scheduledPrompt.target.projectPath });
		}
		return existingChat?.title
			? m.scheduled_prompts_existing_chat_target({ title: existingChat.title })
			: m.scheduled_prompts_missing_chat_target({ id: scheduledPrompt.target.chatId });
	});
	let newChatTarget = $derived(
		scheduledPrompt.target.type === 'new-chat' ? scheduledPrompt.target : null,
	);
</script>

<article class="rounded-md border border-border bg-card p-3">
	<div class="flex min-w-0 items-start gap-3">
		<div class="min-w-0 flex-1 space-y-1">
			<h3 class="truncate text-sm font-medium text-foreground" {title}>{title}</h3>
			<p class="text-xs text-muted-foreground">
				{formatScheduledInstant(scheduledPrompt.schedule.nextRunAt)}
				<span class="whitespace-nowrap" aria-hidden="true">({relativeRunLabel})</span> - {cadence}
			</p>
			<p class="truncate text-xs text-muted-foreground" title={target}>{target}</p>
			{#if newChatTarget}
				<ChatAgentTags
					agentId={newChatTarget.agentId}
					tags={newChatTarget.tags}
					class="mt-1"
				/>
			{/if}
		</div>
		<div class="grid shrink-0 grid-cols-2 gap-1 sm:flex">
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveUp}
				disabled={disabled || index === 0}
				title={m.scheduled_prompts_move_up()}
				aria-label={m.scheduled_prompts_move_up()}
			>
				<ArrowUp class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveDown}
				disabled={disabled || index === total - 1}
				title={m.scheduled_prompts_move_down()}
				aria-label={m.scheduled_prompts_move_down()}
			>
				<ArrowDown class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onEdit}
				{disabled}
				title={m.scheduled_prompts_edit()}
				aria-label={m.scheduled_prompts_edit()}
			>
				<Pencil class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-destructive hover:text-destructive"
				onclick={onRemove}
				{disabled}
				title={m.scheduled_prompts_remove()}
				aria-label={m.scheduled_prompts_remove()}
			>
				<Trash2 class="h-4 w-4" />
			</Button>
		</div>
	</div>
</article>
