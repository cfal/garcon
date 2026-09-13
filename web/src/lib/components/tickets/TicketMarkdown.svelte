<script module lang="ts">
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
	const markdown = lazyRenderer(() => import('$lib/components/chat/Markdown.svelte'));
</script>

<script lang="ts">
	let { text }: { text: string } = $props();
</script>

<div class="ticket-markdown">
	{#await markdown()}<p class="whitespace-pre-wrap">{text}</p>
	{:then Markdown}<Markdown source={text} />{/await}
</div>
