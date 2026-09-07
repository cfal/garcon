<script lang="ts">
	import Bot from '@lucide/svelte/icons/bot';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
	import Users from '@lucide/svelte/icons/users';
	import * as Popover from '$lib/components/ui/popover';
	import type {
		SubagentManagementEntry,
		SubagentManagementModel,
		SubagentManagementStatus,
	} from '$lib/chat/transcript/subagent-management.js';
	import {
		FLOATING_TAB_ACTIVE_CLASS,
		FLOATING_TAB_IDLE_CLASS,
		FLOATING_TAB_TRIGGER_CLASS,
		FLOATING_TOOLBAR_RAIL_CLASS,
	} from '$lib/components/shared/floating-toolbar-styles.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		model: SubagentManagementModel;
		onJumpToTool?: (anchorId: string) => void;
	}

	let { model, onJumpToTool }: Props = $props();

	let open = $state(false);

	const rootEntry = $derived(model.entries.find((entry) => entry.kind === 'root'));

	// Surfaces the most urgent subagent status while the control is collapsed.
	const summaryStatus = $derived.by<SubagentManagementStatus>(() => {
		if (model.subagents.some((entry) => entry.status === 'error')) return 'error';
		if (model.subagents.some((entry) => entry.status === 'running')) return 'running';
		if (
			model.subagents.some((entry) => entry.status === 'waiting' || entry.status === 'interrupted')
		)
			return 'waiting';
		return 'idle';
	});

	function statusTone(status: SubagentManagementStatus): string {
		switch (status) {
			case 'running':
				return 'text-status-success-foreground';
			case 'waiting':
			case 'interrupted':
				return 'text-status-warning-muted-foreground';
			case 'closed':
			case 'completed':
			case 'idle':
			case 'observing':
				return 'text-muted-foreground';
			case 'error':
				return 'text-status-error-foreground';
		}
	}

	function detailFor(entry: SubagentManagementEntry): string {
		return [entry.statusLabel, entry.model, entry.path].filter(Boolean).join(' · ');
	}

	function selectEntry(entry: SubagentManagementEntry): void {
		if (!entry.anchorId) return;
		open = false;
		onJumpToTool?.(entry.anchorId);
	}
</script>

{#if model.subagents.length > 0}
	<Popover.Root bind:open>
		<div class={FLOATING_TOOLBAR_RAIL_CLASS}>
			<Popover.Trigger
				class={cn(
					FLOATING_TAB_TRIGGER_CLASS,
					open ? FLOATING_TAB_ACTIVE_CLASS : FLOATING_TAB_IDLE_CLASS,
				)}
			>
				<Users class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span class="min-w-0 truncate">Agents</span>
				<span
					class={cn(
						'flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none',
						statusTone(summaryStatus),
					)}
				>
					<span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
					<span class="text-muted-foreground">{model.subagents.length}</span>
				</span>
				<ChevronDown
					class={cn(
						'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
						open && 'rotate-180',
					)}
					aria-hidden="true"
				/>
			</Popover.Trigger>
		</div>

		<Popover.Content align="start" sideOffset={6} class="w-72 p-0">
			<div class="bg-popover text-popover-foreground rounded-md border border-border">
				{#if rootEntry}
					<div class="flex items-center gap-2 border-b border-border/70 px-3 py-2">
						<Bot class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">{rootEntry.name}</div>
							{#if rootEntry.model}
								<div class="truncate text-xs text-muted-foreground">{rootEntry.model}</div>
							{/if}
						</div>
						<span
							class={cn('size-2 shrink-0 rounded-full bg-current', statusTone(rootEntry.status))}
							title={rootEntry.statusLabel}
						></span>
					</div>
				{/if}

				<ul class="max-h-72 overflow-y-auto py-1">
					{#each model.subagents as entry (entry.id)}
						<li>
							<button
								type="button"
								class="group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-hidden disabled:cursor-default disabled:hover:bg-transparent"
								disabled={!entry.anchorId}
								onclick={() => selectEntry(entry)}
							>
								<span
									class={cn('size-2 shrink-0 rounded-full bg-current', statusTone(entry.status))}
									aria-hidden="true"
								></span>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm font-medium">{entry.name}</div>
									<div class="truncate text-xs text-muted-foreground">{detailFor(entry)}</div>
								</div>
								{#if entry.anchorId}
									<CornerDownLeft
										class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
										aria-hidden="true"
									/>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</Popover.Content>
	</Popover.Root>
{/if}
