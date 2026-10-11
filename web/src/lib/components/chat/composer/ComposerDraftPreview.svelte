<script lang="ts">
	import { onMount } from 'svelte';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		source,
		onEdit,
		onSubmitKeydown,
	}: {
		source: string;
		onEdit: () => void;
		onSubmitKeydown: (event: KeyboardEvent) => void;
	} = $props();
	const markdownRenderer = lazyRenderer(() => import('./ComposerMarkdownPreview.svelte'));
	let preview: HTMLDivElement;
	onMount(() => preview.focus({ preventScroll: true }));

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onEdit();
		} else if (event.key === 'Enter') onSubmitKeydown(event);
	}
</script>

<div class="flex items-center justify-between px-4 pt-2 sm:px-5">
	<span class="text-xs text-muted-foreground">{m.chat_composer_markdown_preview()}</span>
	<button
		type="button"
		onclick={onEdit}
		class="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	>
		<Pencil class="size-3.5" aria-hidden="true" />{m.chat_composer_edit_markdown()}
	</button>
</div>
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The scrollable preview supports keyboard scrolling and submission; composer-markdown.test.ts verifies its focus and shortcuts.) -->
<div
	bind:this={preview}
	tabindex="0"
	role="region"
	aria-label={m.chat_composer_markdown_preview()}
	data-composer-markdown-preview
	class="max-h-[min(40dvh,150px)] overflow-auto px-4 pb-3 pt-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:max-h-[min(40dvh,300px)] sm:px-5 sm:pb-3.5"
	onkeydown={handleKeydown}
>
	{#await markdownRenderer()}
		<pre class="whitespace-pre-wrap text-sm">{source}</pre>
	{:then MarkdownPreview}
		<MarkdownPreview {source} />
	{:catch}
		<p class="text-sm text-muted-foreground">{m.chat_composer_markdown_preview_failed()}</p>
	{/await}
</div>
