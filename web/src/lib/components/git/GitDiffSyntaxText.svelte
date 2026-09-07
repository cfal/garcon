<script lang="ts">
	import type { CodeHighlightSegment } from '$lib/highlighting/code-highlight-types.js';

	interface Props {
		className: string;
		prefix: string;
		text: string;
		segments?: readonly CodeHighlightSegment[];
	}

	let { className, prefix, text, segments }: Props = $props();
</script>

<span class="code-highlight {className}"
	>{prefix}{#if segments}{#each segments as segment, index (index)}{#if segment.className}<span
					class={segment.className}>{segment.text}</span
				>{:else}{segment.text}{/if}{/each}{:else}{text}{/if}</span
>
