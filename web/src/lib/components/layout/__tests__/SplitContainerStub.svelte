<script lang="ts">
	import type { LayoutNode, PaneNode } from '$lib/stores/split-layout.svelte';

	interface SplitContainerStubProps {
		node: LayoutNode;
		focusedPaneId?: string | null;
		previewStore?: unknown;
		textScale?: number;
		onFocusPane?: (paneId: string) => void;
		onMaximizePane?: (paneId: string) => void;
	}

	let {
		node,
		focusedPaneId = null,
		textScale = 1,
		onFocusPane,
		onMaximizePane,
	}: SplitContainerStubProps = $props();

	function collectPanes(nodeToRead: LayoutNode): PaneNode[] {
		if (nodeToRead.type === 'pane') return [nodeToRead];
		return [...collectPanes(nodeToRead.children[0]), ...collectPanes(nodeToRead.children[1])];
	}

	let panes = $derived(collectPanes(node));
</script>

<div data-testid="split-container-stub" data-text-scale={String(textScale)}>
	{#each panes as pane (pane.id)}
		<div data-pane-id={pane.id}>
			<div data-pane-body data-focused={focusedPaneId === pane.id ? 'true' : 'false'}>
				{pane.chatId}
				<button
					type="button"
					aria-label={`Focus pane showing ${pane.chatId}`}
					onclick={() => onFocusPane?.(pane.id)}
				>
					Focus
				</button>
				<button
					type="button"
					aria-label={`Maximize pane showing ${pane.chatId}`}
					onclick={() => onMaximizePane?.(pane.id)}
				>
					Maximize
				</button>
			</div>
		</div>
	{/each}
</div>
