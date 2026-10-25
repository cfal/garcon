<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { setMarkdownLinkActions } from '$lib/context/markdown-link-actions-context.js';

	let { children }: { children: Snippet } = $props();
	let actions = $state.raw<Array<{ element: HTMLElement; render: Snippet }>>([]);

	// Descendant image controls must remain outside the authored anchor.
	setMarkdownLinkActions((element, render) => {
		const action = { element, render };
		untrack(() => {
			actions = [...actions, action].sort((left, right) => {
				const position = left.element.compareDocumentPosition(right.element);
				if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
				if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
				return 0;
			});
		});
		return () => {
			untrack(() => {
				actions = actions.filter((registeredAction) => registeredAction !== action);
			});
		};
	});
</script>

{@render children()}{#each actions as action (action)}
	{@render action.render()}
{/each}
