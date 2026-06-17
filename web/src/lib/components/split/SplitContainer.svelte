<script lang="ts">
	import type { LayoutNode } from '$lib/stores/split-layout.svelte';
	import type { SplitPanePreviewStore } from '$lib/chat/split-pane-preview-store.svelte';
	import SplitResizer from './SplitResizer.svelte';
	import ChatPane from './ChatPane.svelte';
	import Self from './SplitContainer.svelte';

	interface SplitContainerProps {
		node: LayoutNode;
		path?: number[];
		focusedPaneId: string | null;
		draggedChatId: string | null;
		previewStore: SplitPanePreviewStore;
		onFocusPane: (paneId: string) => void;
		onClosePane: (paneId: string) => void;
		onDeleteChat: (paneId: string) => void;
		onSetRatio: (path: number[], ratio: number) => void;
		onDropChat: (paneId: string, zone: 'left' | 'right' | 'top' | 'bottom' | 'center') => void;
	}

	let {
		node,
		path = [],
		focusedPaneId,
		draggedChatId,
		previewStore,
		onFocusPane,
		onClosePane,
		onDeleteChat,
		onSetRatio,
		onDropChat,
	}: SplitContainerProps = $props();

	// Tracks the container element for computing resize ratios.
	let containerEl: HTMLDivElement | undefined = $state();

	// Resize state for live dragging.
	let startRatio = $state(0);
	let containerSize = $state(0);

	function handleResizeStart() {
		if (node.type !== 'split' || !containerEl) return;
		startRatio = node.ratio;
		const rect = containerEl.getBoundingClientRect();
		containerSize = node.direction === 'horizontal' ? rect.width : rect.height;
	}

	function handleResize(delta: number) {
		if (node.type !== 'split' || containerSize === 0) return;
		const ratioDelta = delta / containerSize;
		onSetRatio(path, startRatio + ratioDelta);
	}
</script>

{#if node.type === 'pane'}
	<ChatPane
		paneId={node.id}
		chatId={node.chatId}
		isFocused={focusedPaneId === node.id}
		{draggedChatId}
		{previewStore}
		onFocus={() => onFocusPane(node.id)}
		onClose={() => onClosePane(node.id)}
		onDelete={() => onDeleteChat(node.id)}
		onDrop={(zone) => onDropChat(node.id, zone)}
	/>
{:else}
	{@const isHorizontal = node.direction === 'horizontal'}
	{@const firstPercent = node.ratio * 100}
	{@const secondPercent = (1 - node.ratio) * 100}
	<!-- svelte-ignore a11y_no_static_element_interactions -- pointerdown captures resize start position -->
	<div
		bind:this={containerEl}
		class="h-full w-full flex overflow-hidden gap-0.5 p-px"
		class:flex-row={isHorizontal}
		class:flex-col={!isHorizontal}
		onpointerdown={handleResizeStart}
	>
		<div
			class="overflow-hidden min-w-0 min-h-0 rounded-lg"
			style:flex={`0 0 calc(${firstPercent}% - 3px)`}
		>
			<Self
				node={node.children[0]}
				path={[...path, 0]}
				{focusedPaneId}
				{draggedChatId}
				{previewStore}
				{onFocusPane}
				{onClosePane}
				{onDeleteChat}
				{onSetRatio}
				{onDropChat}
			/>
		</div>

		<SplitResizer direction={node.direction} onResize={handleResize} />

		<div
			class="overflow-hidden min-w-0 min-h-0 rounded-lg"
			style:flex={`0 0 calc(${secondPercent}% - 3px)`}
		>
			<Self
				node={node.children[1]}
				path={[...path, 1]}
				{focusedPaneId}
				{draggedChatId}
				{previewStore}
				{onFocusPane}
				{onClosePane}
				{onDeleteChat}
				{onSetRatio}
				{onDropChat}
			/>
		</div>
	</div>
{/if}
