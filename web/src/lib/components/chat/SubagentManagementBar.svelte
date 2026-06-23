<script lang="ts">
	import Bot from '@lucide/svelte/icons/bot';
	import Circle from '@lucide/svelte/icons/circle';
	import Users from '@lucide/svelte/icons/users';
	import type {
		SubagentManagementEntry,
		SubagentManagementModel,
		SubagentManagementStatus,
	} from '$lib/chat/subagent-management';
	import { cn } from '$lib/utils/cn';

	interface Props {
		model: SubagentManagementModel;
		reserveToolbarSpace?: boolean;
		onJumpToTool?: (anchorId: string) => void;
	}

	let { model, reserveToolbarSpace = false, onJumpToTool }: Props = $props();

	function statusTone(status: SubagentManagementStatus): string {
		switch (status) {
			case 'running':
				return 'text-status-success-foreground';
			case 'waiting':
			case 'interrupted':
				return 'text-status-warning-muted-foreground';
			case 'closed':
			case 'idle':
			case 'observing':
				return 'text-muted-foreground';
			case 'error':
				return 'text-status-error-foreground';
		}
	}

	function entryTitle(entry: SubagentManagementEntry): string {
		const parts = [entry.name, entry.statusLabel, entry.model, entry.path, entry.message].filter(
			Boolean,
		);
		return parts.join(' · ');
	}

	function jumpToEntry(entry: SubagentManagementEntry): void {
		if (entry.anchorId) onJumpToTool?.(entry.anchorId);
	}
</script>

{#if model.subagents.length > 0}
	<div
		class={cn(
			'border-b border-border/70 bg-background/95 px-3 py-2',
			reserveToolbarSpace && 'sm:pr-64',
		)}
	>
		<div class="flex min-w-0 items-center gap-2">
			<div class="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
				<Users class="h-3.5 w-3.5" aria-hidden="true" />
				<span>Agents</span>
				<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
					{model.subagents.length}
				</span>
			</div>

			<div class="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-px">
				{#each model.entries as entry (entry.id)}
					{#if entry.kind === 'root'}
						<div
							class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted/35 px-2.5 text-xs text-foreground"
							title={entryTitle(entry)}
						>
							<Bot class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
							<span class="max-w-32 truncate font-medium">{entry.name}</span>
							{#if entry.model}
								<span class="max-w-24 truncate text-muted-foreground">{entry.model}</span>
							{/if}
							<span class={cn('flex items-center gap-1', statusTone(entry.status))}>
								<Circle class="h-2 w-2 fill-current" aria-hidden="true" />
								<span class="sr-only">{entry.statusLabel}</span>
							</span>
						</div>
					{:else}
						<button
							type="button"
							class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs text-foreground shadow-xs transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60"
							title={entryTitle(entry)}
							disabled={!entry.anchorId}
							onclick={() => jumpToEntry(entry)}
						>
							<span class={cn('flex items-center gap-1', statusTone(entry.status))}>
								<Circle class="h-2 w-2 fill-current" aria-hidden="true" />
								<span class="sr-only">{entry.statusLabel}</span>
							</span>
							<span class="max-w-36 truncate font-medium">{entry.name}</span>
							{#if entry.lastActionLabel}
								<span class="max-w-20 truncate text-muted-foreground">{entry.lastActionLabel}</span>
							{/if}
							{#if entry.model}
								<span class="max-w-24 truncate text-muted-foreground">{entry.model}</span>
							{/if}
						</button>
					{/if}
				{/each}
			</div>
		</div>
	</div>
{/if}
