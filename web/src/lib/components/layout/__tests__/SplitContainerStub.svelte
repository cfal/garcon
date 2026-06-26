<script lang="ts">
	import type { LayoutNode, PaneNode } from '$lib/stores/split-layout.svelte';

	interface SplitContainerStubProps {
		node: LayoutNode;
		previewStore?: unknown;
		textScale?: number;
	}

	let { node, textScale = 1 }: SplitContainerStubProps = $props();

	function collectPanes(nodeToRead: LayoutNode): PaneNode[] {
		if (nodeToRead.type === 'pane') return [nodeToRead];
		return [...collectPanes(nodeToRead.children[0]), ...collectPanes(nodeToRead.children[1])];
	}

	let panes = $derived(collectPanes(node));
</script>

<div data-testid="split-container-stub" data-text-scale={String(textScale)}>
	{#each panes as pane (pane.id)}
		<div data-pane-id={pane.id}>
			<div data-pane-body>
				{pane.chatId}
			</div>
		</div>
	{/each}
</div>
