<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import { formatCompactProjectPath } from '$lib/chat/project-paths/compact-project-path';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';
	import type { WorkMapChatNode } from '$lib/work-map/work-map-model';

	interface WorkMapChatCardProps {
		node: WorkMapChatNode;
		selectedChatId: string | null;
		currentTime: Date;
		searchActive: boolean;
	}

	let { node, selectedChatId, currentTime, searchActive }: WorkMapChatCardProps = $props();

	const title = $derived(node.chat.title || m.sidebar_chats_unnamed());
	const selected = $derived(selectedChatId === node.chat.id);
	const projectPath = $derived(formatCompactProjectPath(node.chat.projectPath));
	const activity = $derived(
		formatRelativeTimestamp(node.chat.lastActivityAt ?? node.chat.createdAt, currentTime),
	);
	const relation = $derived(
		node.relation === 'fork'
			? m.work_map_relation_fork()
			: node.relation === 'handoff'
				? m.work_map_relation_handoff()
				: null,
	);
</script>

<article
	class={cn(
		'min-w-0 flex-1 overflow-hidden rounded-lg border bg-card shadow-sm transition-colors',
		selected ? 'border-primary/50 bg-accent/30' : 'border-border hover:border-primary/30',
		searchActive && !node.matchesQuery && 'opacity-70',
	)}
	data-work-map-chat-card={node.chat.id}
	data-work-map-context={searchActive && !node.matchesQuery ? 'true' : undefined}
>
	<a
		href={`/chat/${node.chat.id}`}
		class="block min-w-0 px-3 py-2.5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
		aria-current={selected ? 'page' : undefined}
		data-work-map-chat-id={node.chat.id}
	>
		<div class="flex min-w-0 items-start gap-2">
			<div class="min-w-0 flex-1">
				<div class="flex min-w-0 flex-wrap items-center gap-1.5">
					<span class="min-w-0 truncate text-sm font-semibold">{title}</span>
					{#if relation}
						<span
							class="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
						>
							{relation}
						</span>
					{/if}
					{#if selected}
						<span
							class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
						>
							{m.work_map_status_current()}
						</span>
					{/if}
					{#if searchActive && !node.matchesQuery}
						<span class="sr-only">{m.work_map_context_only()}</span>
					{/if}
				</div>

				<div
					class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
				>
					<span class="rounded bg-muted px-1.5 py-0.5 font-medium">{node.chat.agentId}</span>
					{#if node.chat.model}
						<span class="max-w-48 truncate" title={node.chat.model}>{node.chat.model}</span>
					{/if}
					{#if projectPath}
						<span class="max-w-64 truncate font-medium" title={node.chat.projectPath}>
							{projectPath}
						</span>
					{/if}
					{#if activity}
						<time class="whitespace-nowrap tabular-nums" title={activity.tooltip}>
							{activity.label}
						</time>
					{/if}
				</div>
			</div>

			{#if node.chat.isProcessing}
				<span
					class="mt-1 flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground"
				>
					<span class="size-2 rounded-full bg-status-processing" aria-hidden="true"></span>
					<span class="sr-only">{m.work_map_status_processing()}</span>
				</span>
			{/if}
		</div>

		{#if node.chat.isUnread || node.chat.isArchived || node.inCycle}
			<div class="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] font-medium">
				{#if node.chat.isUnread}
					<span class="rounded-full border border-primary/30 px-1.5 py-0.5 text-primary">
						{m.work_map_status_unread()}
					</span>
				{/if}
				{#if node.chat.isArchived}
					<span class="rounded-full border border-border px-1.5 py-0.5 text-muted-foreground">
						{m.work_map_status_archived()}
					</span>
				{/if}
				{#if node.inCycle}
					<span
						class="inline-flex items-center gap-1 rounded-full border border-status-warning-border bg-status-warning/10 px-1.5 py-0.5 text-status-warning-muted-foreground"
						title={node.cycleBreak ? m.work_map_cycle_break() : m.work_map_cycle_warning()}
					>
						<CircleAlert class="size-3" aria-hidden="true" />
						{m.work_map_cycle_warning()}
					</span>
				{/if}
			</div>
		{/if}
	</a>
</article>
