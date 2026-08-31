<script lang="ts">
	import CollapsibleBody from '../rows/CollapsibleBody.svelte';

	interface Props {
		content: string;
		focusable?: boolean;
		margined?: boolean;
		expanded?: boolean;
		onExpandedChange?: (expanded: boolean) => void;
	}

	let { content, focusable = false, margined = false, expanded, onExpandedChange }: Props = $props();
</script>

<CollapsibleBody disclosure="collapsed" {expanded} {onExpandedChange}>
	{#snippet children()}
		<div class:mt-1={margined}>{content}</div>
		{#if focusable}
			<a href="https://example.com">Focusable content</a>
		{/if}
	{/snippet}
</CollapsibleBody>
