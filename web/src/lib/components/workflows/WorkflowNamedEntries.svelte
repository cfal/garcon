<script lang="ts">
	import type { Snippet } from 'svelte';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	let {
		title,
		add,
		entries,
		canRemove = true,
		onEdit,
		onRemove,
		children,
	}: {
		title: string;
		add: string;
		entries: readonly { id: string; summary: string }[];
		canRemove?: boolean;
		onEdit: (id: string | null) => void;
		onRemove: (id: string) => void;
		children: Snippet;
	} = $props();
</script>

<details class="min-w-0 border-t border-border text-sm">
	<summary
		class="cursor-pointer py-2 font-medium focus-visible:outline-2 focus-visible:outline-ring"
		>{title}</summary
	>
	<div class="space-y-2 pb-2">
		{#if entries.length}
			<ul class="divide-y divide-border">
				{#each entries as entry (entry.id)}
					<svelte:boundary>
						<li class="flex min-w-0 items-center gap-1 py-1">
							<div class="min-w-0 flex-1">
								<p class="wrap-anywhere font-medium">{entry.id}</p>
								<p class="wrap-anywhere text-xs text-muted-foreground">{entry.summary}</p>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								title={m.workflow_studio_edit_named({ name: entry.id })}
								aria-label={m.workflow_studio_edit_named({ name: entry.id })}
								onclick={() => onEdit(entry.id)}><Pencil class="size-4" /></Button
							>
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={!canRemove}
								title={m.workflow_studio_remove_named({ name: entry.id })}
								aria-label={m.workflow_studio_remove_named({ name: entry.id })}
								onclick={() => onRemove(entry.id)}><Trash2 class="size-4" /></Button
							>
						</li>
						{#snippet failed()}<li class="text-xs text-destructive">
								{m.workflow_studio_field_unavailable()}
							</li>{/snippet}
					</svelte:boundary>
				{/each}
			</ul>
		{/if}
		<Button size="sm" variant="outline" onclick={() => onEdit(null)}
			><Plus class="size-4" /> {add}</Button
		>
		{@render children()}
	</div>
</details>
