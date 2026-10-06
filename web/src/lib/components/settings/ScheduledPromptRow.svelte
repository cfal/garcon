<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import ChatAgentTags from '$lib/components/shared/ChatAgentTags.svelte';
	import { formatCompactTimeUntil, formatScheduledDate } from '$lib/scheduling/local-schedule';
	import {
		recurringCadenceLabel,
		scheduledInstantLabel,
		scheduledPromptTitle,
		scheduledRunOutcomeLabel,
	} from '$lib/scheduling/schedule-labels';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { ScheduledPrompt, ScheduledPromptRunLogEntry } from '$shared/scheduled-prompts';
	import ScheduledRunOutcomeIcon from './ScheduledRunOutcomeIcon.svelte';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Cpu from '@lucide/svelte/icons/cpu';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import FileText from '@lucide/svelte/icons/file-text';
	import Folder from '@lucide/svelte/icons/folder';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import ExecutorPill from '$lib/components/shared/ExecutorPill.svelte';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Repeat from '@lucide/svelte/icons/repeat';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		scheduledPrompt: ScheduledPrompt;
		index: number;
		total: number;
		existingChat?: Pick<ChatSessionRecord, 'id' | 'title'>;
		executorLabel?: string;
		lastRun?: ScheduledPromptRunLogEntry;
		// Set only when the chat a run created still exists and can be opened.
		lastRunChatId?: string | null;
		currentTime: Date;
		disabled?: boolean;
		onEdit: () => void;
		onRemove: () => void;
		onMoveUp: () => void;
		onMoveDown: () => void;
		onOpenChat?: (chatId: string) => void;
	}

	let {
		scheduledPrompt,
		index,
		total,
		existingChat,
		executorLabel,
		lastRun,
		lastRunChatId = null,
		currentTime,
		disabled = false,
		onEdit,
		onRemove,
		onMoveUp,
		onMoveDown,
		onOpenChat,
	}: Props = $props();

	const headingId = $props.id();
	let title = $derived(scheduledPromptTitle(scheduledPrompt.prompt));
	let schedule = $derived(scheduledPrompt.schedule);
	let timeUntilRun = $derived(formatCompactTimeUntil(schedule.nextRunAt, currentTime));
	let nextRunLabel = $derived(scheduledInstantLabel(schedule.nextRunAt, currentTime));
	let relativeRunLabel = $derived(
		timeUntilRun ? m.scheduled_prompts_runs_in({ duration: timeUntilRun }) : m.scheduled_prompts_due_now(),
	);
	let cadence = $derived(
		schedule.type === 'once'
			? m.scheduled_prompts_once()
			: recurringCadenceLabel(schedule.intervalMinutes),
	);
	let endLabel = $derived(
		schedule.type === 'recurring' && schedule.endAt
			? m.scheduled_prompts_until({ date: formatScheduledDate(schedule.endAt) })
			: null,
	);
	let newChatTarget = $derived(
		scheduledPrompt.target.type === 'new-chat' ? scheduledPrompt.target : null,
	);
	let projectName = $derived(
		newChatTarget
			? newChatTarget.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ||
					newChatTarget.projectPath
			: '',
	);
	let explicitPreambleCount = $derived(
		newChatTarget?.preambleChoice.mode === 'explicit'
			? newChatTarget.preambleChoice.orderedPreambleIds.length
			: null,
	);
	let lastRunSummary = $derived(
		lastRun
			? m.scheduled_prompts_last_run({
					when: scheduledInstantLabel(lastRun.at, currentTime),
					outcome: scheduledRunOutcomeLabel(lastRun.outcome),
				})
			: null,
	);

	const chipClass =
		'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground';
</script>

<article class="rounded-lg border border-border bg-card p-3 sm:p-4" aria-labelledby={headingId}>
	<div class="flex min-w-0 items-start gap-2">
		<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs">
			{#if executorLabel}
				<ExecutorPill label={executorLabel} data-slot="scheduled-prompt-executor" />
			{/if}
			<span
				class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-foreground"
				data-slot="scheduled-prompt-cadence"
			>
				{#if schedule.type === 'once'}
					<CalendarClock class="h-3 w-3 shrink-0" aria-hidden="true" />
				{:else}
					<Repeat class="h-3 w-3 shrink-0" aria-hidden="true" />
				{/if}
				{cadence}
				{#if endLabel}
					<span class="font-normal text-muted-foreground">{endLabel}</span>
				{/if}
			</span>
			<span class="text-foreground" data-slot="scheduled-prompt-next-run">
				{nextRunLabel}
				<span class="whitespace-nowrap text-muted-foreground">· {relativeRunLabel}</span>
			</span>
		</div>
		<div class="-mr-1 -mt-0.5 flex shrink-0 items-center">
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
			<DropdownMenu>
				<DropdownMenuTrigger
					class={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }))}
					{disabled}
					title={m.scheduled_prompts_actions()}
					aria-label={m.scheduled_prompts_actions()}
				>
					<EllipsisVertical class="h-4 w-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onclick={onMoveUp} disabled={index === 0}>
						<ArrowUp class="h-4 w-4" />
						{m.scheduled_prompts_move_up()}
					</DropdownMenuItem>
					<DropdownMenuItem onclick={onMoveDown} disabled={index === total - 1}>
						<ArrowDown class="h-4 w-4" />
						{m.scheduled_prompts_move_down()}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onclick={onRemove}>
						<Trash2 class="h-4 w-4" />
						{m.scheduled_prompts_remove()}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	</div>

	<h3
		id={headingId}
		class="mt-2 line-clamp-2 break-words text-sm font-medium text-foreground"
		{title}
	>
		{title}
	</h3>

	<div class="mt-2 flex min-w-0 items-center text-xs text-muted-foreground">
		{#if newChatTarget}
			<span
				class="inline-flex min-w-0 max-w-full items-center gap-1"
				title={newChatTarget.projectPath}
				data-slot="scheduled-prompt-target"
			>
				<Folder class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span class="truncate">{m.scheduled_prompts_new_chat_in({ project: projectName })}</span>
			</span>
		{:else if existingChat?.title && onOpenChat}
			<button
				type="button"
				class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				title={m.scheduled_prompts_open_chat_named({ title: existingChat.title })}
				data-slot="scheduled-prompt-target"
				onclick={() => onOpenChat(existingChat.id)}
			>
				<MessageSquare class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span class="truncate">{existingChat.title}</span>
			</button>
		{:else if existingChat?.title}
			<span class="inline-flex min-w-0 max-w-full items-center gap-1" data-slot="scheduled-prompt-target">
				<MessageSquare class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span class="truncate">{existingChat.title}</span>
			</span>
		{:else if scheduledPrompt.target.type === 'existing-chat'}
			<span class="truncate text-destructive" data-slot="scheduled-prompt-target">
				{m.scheduled_prompts_missing_chat_target({ id: scheduledPrompt.target.chatId })}
			</span>
		{/if}
	</div>

	{#if newChatTarget}
		<div class="mt-2 flex flex-wrap items-center gap-1.5">
			<ChatAgentTags agentId={newChatTarget.agentId} tags={newChatTarget.tags} />
			<span
				class={chipClass}
				title={m.scheduled_prompts_model({ model: newChatTarget.model })}
				data-slot="scheduled-prompt-model"
			>
				<Cpu class="h-3 w-3 shrink-0" aria-hidden="true" />
				<span class="truncate">{newChatTarget.model}</span>
			</span>
			{#if explicitPreambleCount !== null}
				{@const preambleLabel = m.scheduled_prompts_preamble_count({
					count: explicitPreambleCount,
				})}
				<span class={chipClass} title={preambleLabel} data-slot="scheduled-prompt-preamble-choice">
					<FileText class="h-3 w-3 shrink-0" aria-hidden="true" />
					<span class="truncate">{preambleLabel}</span>
				</span>
			{/if}
		</div>
	{/if}

	{#if lastRun && lastRunSummary}
		<div
			class="mt-3 flex min-w-0 items-start gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground"
			data-slot="scheduled-prompt-last-run"
			title={lastRun.outcome === 'failed' || lastRun.outcome === 'missed' ? lastRun.message : undefined}
		>
			<ScheduledRunOutcomeIcon outcome={lastRun.outcome} class="mt-px h-3.5 w-3.5" />
			<span class="min-w-0 break-words">{lastRunSummary}</span>
			{#if lastRunChatId && onOpenChat}
				<button
					type="button"
					class="ml-auto shrink-0 rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onclick={() => onOpenChat(lastRunChatId)}
				>
					{m.scheduled_prompts_open_chat()}
				</button>
			{/if}
		</div>
	{/if}
</article>
