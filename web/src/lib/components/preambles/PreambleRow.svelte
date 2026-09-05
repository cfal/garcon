<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
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
		onEnabledChange: (enabled: boolean) => void;
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
		onEnabledChange,
	}: Props = $props();

	function projectPathBadgeLabel(count: number): string {
		if (count === 1) return m.preambles_project_path_badge_singular();
		return m.preambles_project_path_badge_plural({ count });
	}
</script>

<article
	data-slot="preamble-row"
	class="rounded-md border border-border p-3 transition-colors {preamble.enabled
		? 'bg-card'
		: 'bg-muted/30'}"
>
	<div class="flex min-w-0 items-start gap-3">
		<div class="min-w-0 flex-1 space-y-2">
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<h3
					data-slot="preamble-row-title"
					class="min-w-0 truncate text-sm font-medium text-foreground"
					title={preamble.title}
				>
					{preamble.title}
				</h3>
				{#if preamble.scope.type === 'global'}
					<span class="rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">
						{m.preambles_global_badge()}
					</span>
				{:else}
					<span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
						{projectPathBadgeLabel(preamble.scope.rules.length)}
					</span>
				{/if}
				{#if !preamble.enabled}
					<span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
						{m.preambles_disabled_badge()}
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
		<div class="grid shrink-0 grid-cols-2 gap-1 sm:flex sm:items-center">
			<Switch
				class="col-span-2 mx-auto mb-1 sm:col-span-1 sm:mb-0 sm:mr-1"
				checked={preamble.enabled}
				{disabled}
				onCheckedChange={onEnabledChange}
				aria-label={preamble.enabled
					? m.preambles_disable_toggle({ title: preamble.title })
					: m.preambles_enable_toggle({ title: preamble.title })}
			/>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveUp}
				disabled={disabled || reorderDisabled || index === 0}
				title={m.preambles_move_up_named({ title: preamble.title })}
				aria-label={m.preambles_move_up_named({ title: preamble.title })}
			>
				<ArrowUp class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveDown}
				disabled={disabled || reorderDisabled || index === total - 1}
				title={m.preambles_move_down_named({ title: preamble.title })}
				aria-label={m.preambles_move_down_named({ title: preamble.title })}
			>
				<ArrowDown class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onEdit}
				{disabled}
				title={m.preambles_edit_named({ title: preamble.title })}
				aria-label={m.preambles_edit_named({ title: preamble.title })}
			>
				<Pencil class="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-destructive hover:text-destructive"
				onclick={onRemove}
				{disabled}
				title={m.preambles_remove_named({ title: preamble.title })}
				aria-label={m.preambles_remove_named({ title: preamble.title })}
			>
				<Trash2 class="h-4 w-4" />
			</Button>
		</div>
	</div>
</article>
