<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { setMarkdownLinkActions } from '$lib/context/markdown-link-actions-context.js';

	let { children }: { children: Snippet } = $props();
	let actions = $state.raw<Snippet[]>([]);

	// Descendant image controls must remain outside the authored anchor.
	setMarkdownLinkActions((action) => {
		untrack(() => (actions = [...actions, action]));
		return () => untrack(() => (actions = actions.filter((item) => item !== action)));
	});
</script>

{@render children()}{#each actions as action (action)}
	{@render action()}
{/each}
