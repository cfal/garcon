<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import { snippetPreview } from '$lib/snippets/snippet-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { Snippet } from '$shared/snippets';

	interface Props {
		snippet: Snippet;
		index: number;
		total: number;
		disabled?: boolean;
		onEdit: () => void;
		onRemove: () => void;
		onMoveUp: () => void;
		onMoveDown: () => void;
	}

	let {
		snippet,
		index,
		total,
		disabled = false,
		onEdit,
		onRemove,
		onMoveUp,
		onMoveDown,
	}: Props = $props();
</script>

<article class="rounded-md border border-border bg-card p-3">
	<div class="flex min-w-0 items-start gap-3">
		<div class="min-w-0 flex-1">
			<h3 class="truncate text-sm font-medium text-foreground">/snippet {snippet.shortName}</h3>
			<p class="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
				{snippetPreview(snippet)}
			</p>
		</div>
		<div class="grid shrink-0 grid-cols-2 gap-1 sm:flex">
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveUp}
				disabled={disabled || index === 0}
				title={m.snippets_move_up({ name: snippet.shortName })}
				aria-label={m.snippets_move_up({ name: snippet.shortName })}
			>
				<ArrowUp class="size-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onMoveDown}
				disabled={disabled || index === total - 1}
				title={m.snippets_move_down({ name: snippet.shortName })}
				aria-label={m.snippets_move_down({ name: snippet.shortName })}
			>
				<ArrowDown class="size-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onEdit}
				{disabled}
				title={m.snippets_edit({ name: snippet.shortName })}
				aria-label={m.snippets_edit({ name: snippet.shortName })}
			>
				<Pencil class="size-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-destructive hover:text-destructive"
				onclick={onRemove}
				{disabled}
				title={m.snippets_remove({ name: snippet.shortName })}
				aria-label={m.snippets_remove({ name: snippet.shortName })}
			>
				<Trash2 class="size-4" />
			</Button>
		</div>
	</div>
</article>
