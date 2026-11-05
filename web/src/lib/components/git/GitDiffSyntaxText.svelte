<script lang="ts">
	import type { CodeHighlightSegment } from '$lib/highlighting/code-highlight-types.js';

	interface Props {
		className: string;
		prefix: string;
		text: string;
		segments?: readonly CodeHighlightSegment[];
	}

	let { className, prefix, text, segments }: Props = $props();
	let element = $state<HTMLSpanElement | null>(null);
	let publication = $state.raw<{ text: string; segments: typeof segments } | null>(null);
	const displayedSegments = $derived(publication?.text === text ? publication.segments : undefined);

	$effect(() => {
		const node = element;
		const next = { text, segments };
		if (!node) return;
		const publish = () => {
			const selection = node.ownerDocument.getSelection();
			if (selection && !selection.isCollapsed) {
				for (let index = 0; index < selection.rangeCount; index += 1) {
					if (selection.getRangeAt(index).intersectsNode(node)) return;
				}
			}
			publication = next;
			node.ownerDocument.removeEventListener('selectionchange', publish);
		};
		// Changing child nodes would invalidate an active browser text selection.
		node.ownerDocument.addEventListener('selectionchange', publish);
		publish();
		return () => node.ownerDocument.removeEventListener('selectionchange', publish);
	});
</script>

<span bind:this={element} class="code-highlight {className}"
	>{prefix}{#if displayedSegments}{#each displayedSegments as segment, index (index)}{#if segment.className}<span
					class={segment.className}>{segment.text}</span
				>{:else}{segment.text}{/if}{/each}{:else}{text}{/if}</span
>
