<script lang="ts">
	import type { LayoutNode, PaneNode } from '$lib/stores/split-layout.svelte';

	interface SplitContainerStubProps {
		node: LayoutNode;
		previewStore?: unknown;
	}

	let { node }: SplitContainerStubProps = $props();

	function collectPanes(nodeToRead: LayoutNode): PaneNode[] {
		if (nodeToRead.type === 'pane') return [nodeToRead];
		return [...collectPanes(nodeToRead.children[0]), ...collectPanes(nodeToRead.children[1])];
	}

	let panes = $derived(collectPanes(node));
</script>

<div data-testid="split-container-stub">
	{#each panes as pane (pane.id)}
		<div data-pane-id={pane.id} data-pane-body>
			{pane.chatId}
		</div>
	{/each}
</div>
