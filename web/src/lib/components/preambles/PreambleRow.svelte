<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { Preamble } from '$shared/preambles';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		preamble: Preamble;
		index: number;
		total: number;
		disabled?: boolean;
		reorderDisabled?: boolean;
		onEdit: () => void;
		onRemove: () => void;
		onMoveUp: () => void;
		onMoveDown: () => void;
	}

	let {
		preamble,
		index,
		total,
		disabled = false,
		reorderDisabled = false,
		onEdit,
		onRemove,
		onMoveUp,
		onMoveDown,
	}: Props = $props();
</script>

<article class="rounded-md border border-border bg-card p-3">
	<div class="flex min-w-0 items-start gap-3">
		<div class="min-w-0 flex-1 space-y-2">
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<h3 class="min-w-0 truncate text-sm font-medium text-foreground" title={preamble.title}>
					{preamble.title}
				</h3>
				{#if preamble.scope.type === 'global'}
					<span class="rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">
						{m.preambles_global_badge()}
					</span>
				{:else}
					<span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
						{m.preambles_project_paths_badge({ count: preamble.scope.rules.length })}
					</span>
				{/if}
			</div>
			<p class="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
				{preamble.content}
			</p>
			{#if preamble.scope.type === 'project-paths'}
				<ul class="space-y-1">
					{#each preamble.scope.rules as rule (rule.projectPath)}
						<li class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
							<span class="min-w-0 truncate" title={rule.projectPath}>{rule.projectPath}</span>
							<span class="shrink-0 rounded bg-muted px-1.5 py-0.5">
								{rule.includeNested ? m.preambles_nested_badge() : m.preambles_exact_badge()}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
		<div class="grid shrink-0 grid-cols-2 gap-1 sm:flex">
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveUp}
				disabled={disabled || reorderDisabled || index === 0}
				title={m.preambles_move_up()}
				aria-label={m.preambles_move_up()}
			>
				<ArrowUp class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveDown}
				disabled={disabled || reorderDisabled || index === total - 1}
				title={m.preambles_move_down()}
				aria-label={m.preambles_move_down()}
			>
				<ArrowDown class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onEdit}
				{disabled}
				title={m.preambles_edit()}
				aria-label={m.preambles_edit()}
			>
				<Pencil class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-destructive hover:text-destructive"
				onclick={onRemove}
				{disabled}
				title={m.preambles_remove()}
				aria-label={m.preambles_remove()}
			>
				<Trash2 class="h-4 w-4" />
			</Button>
		</div>
	</div>
</article>
