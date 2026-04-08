<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutNode } from '$lib/stores/split-layout.svelte';
	import SplitResizer from './SplitResizer.svelte';
	import ChatPane from './ChatPane.svelte';
	import Self from './SplitContainer.svelte';

	interface SplitContainerProps {
		node: LayoutNode;
		path?: number[];
		focusedPaneId: string | null;
		draggedChatId: string | null;
		onFocusPane: (paneId: string) => void;
		onClosePane: (paneId: string) => void;
		onSetRatio: (path: number[], ratio: number) => void;
		onDropChat: (paneId: string, zone: 'left' | 'right' | 'top' | 'bottom') => void;
		focusedPaneContent?: Snippet;
	}

	let {
		node,
		path = [],
		focusedPaneId,
		draggedChatId,
		onFocusPane,
		onClosePane,
		onSetRatio,
		onDropChat,
		focusedPaneContent,
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
		onFocus={() => onFocusPane(node.id)}
		onClose={() => onClosePane(node.id)}
		onDrop={(zone) => onDropChat(node.id, zone)}
		focusedContent={focusedPaneContent}
	/>
{:else}
	{@const isHorizontal = node.direction === 'horizontal'}
	{@const firstPercent = node.ratio * 100}
	{@const secondPercent = (1 - node.ratio) * 100}
	<!-- svelte-ignore a11y_no_static_element_interactions -- pointerdown captures resize start position -->
	<div
		bind:this={containerEl}
		class="h-full w-full flex overflow-hidden"
		class:flex-row={isHorizontal}
		class:flex-col={!isHorizontal}
		onpointerdown={handleResizeStart}
	>
		<div
			class="overflow-hidden min-w-0 min-h-0"
			style:flex={`0 0 calc(${firstPercent}% - 2px)`}
		>
			<Self
				node={node.children[0]}
				path={[...path, 0]}
				{focusedPaneId}
				{draggedChatId}
				{onFocusPane}
				{onClosePane}
				{onSetRatio}
				{onDropChat}
				{focusedPaneContent}
			/>
		</div>

		<SplitResizer
			direction={node.direction}
			onResize={handleResize}
		/>

		<div
			class="overflow-hidden min-w-0 min-h-0"
			style:flex={`0 0 calc(${secondPercent}% - 2px)`}
		>
			<Self
				node={node.children[1]}
				path={[...path, 1]}
				{focusedPaneId}
				{draggedChatId}
				{onFocusPane}
				{onClosePane}
				{onSetRatio}
				{onDropChat}
				{focusedPaneContent}
			/>
		</div>
	</div>
{/if}
