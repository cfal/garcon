<script lang="ts">
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import { snippetPreview } from '$lib/snippets/snippet-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { Snippet } from '$shared/snippets';

	interface Props {
		snippet: Snippet;
		disabled?: boolean;
		onEdit: () => void;
		onRemove: () => void;
	}

	let { snippet, disabled = false, onEdit, onRemove }: Props = $props();
</script>

<article class="rounded-md border border-border bg-card p-3">
	<div class="flex min-w-0 items-start gap-3">
		<div class="min-w-0 flex-1">
			<h3 class="truncate text-sm font-medium text-foreground">{snippet.shortName}</h3>
			<p class="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
				{snippetPreview(snippet)}
			</p>
		</div>
		<div class="flex shrink-0 gap-1">
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
