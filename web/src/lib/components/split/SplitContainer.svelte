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
		textScale?: number;
		onFocusPane: (paneId: string) => void;
		onClosePane: (paneId: string) => void;
		onMaximizePane: (paneId: string) => void;
		onSetRatio: (path: number[], ratio: number) => void;
		onDropChat: (paneId: string, zone: 'left' | 'right' | 'top' | 'bottom' | 'center') => void;
	}

	let {
		node,
		path = [],
		focusedPaneId,
		draggedChatId,
		previewStore,
		textScale = 1,
		onFocusPane,
		onClosePane,
		onMaximizePane,
		onSetRatio,
		onDropChat,
	}: SplitContainerProps = $props();

	// Tracks the container element for computing resize ratios.
	let containerEl: HTMLDivElement | undefined = $state();

	// Resize drag anchor, captured when the resizer's drag starts.
	let startRatio = 0;
	let containerSize = 0;

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

	function handleResizeReset() {
		onSetRatio(path, 0.5);
	}

	function splitTrackTemplate(ratio: number): string {
		return `minmax(0, ${ratio}fr) auto minmax(0, ${1 - ratio}fr)`;
	}
</script>

{#if node.type === 'pane'}
	<ChatPane
		paneId={node.id}
		chatId={node.chatId}
		isFocused={focusedPaneId === node.id}
			{draggedChatId}
			{previewStore}
			{textScale}
			onFocus={() => onFocusPane(node.id)}
		onClose={() => onClosePane(node.id)}
		onMaximize={() => onMaximizePane(node.id)}
		onDrop={(zone) => onDropChat(node.id, zone)}
	/>
{:else}
	{@const isHorizontal = node.direction === 'horizontal'}
	{@const trackTemplate = splitTrackTemplate(node.ratio)}
	<div
		bind:this={containerEl}
		data-split-container
		class="grid h-full w-full overflow-hidden gap-px p-px"
		style:grid-template-columns={isHorizontal ? trackTemplate : undefined}
		style:grid-template-rows={isHorizontal ? undefined : trackTemplate}
	>
		<div data-split-pane-wrapper class="overflow-hidden min-w-0 min-h-0 rounded-lg">
			<Self
				node={node.children[0]}
				path={[...path, 0]}
				{focusedPaneId}
					{draggedChatId}
					{previewStore}
					{textScale}
				{onFocusPane}
				{onClosePane}
				{onMaximizePane}
				{onSetRatio}
				{onDropChat}
			/>
		</div>

		<SplitResizer
			direction={node.direction}
			onResizeStart={handleResizeStart}
			onResize={handleResize}
			onReset={handleResizeReset}
		/>

		<div data-split-pane-wrapper class="overflow-hidden min-w-0 min-h-0 rounded-lg">
			<Self
				node={node.children[1]}
				path={[...path, 1]}
				{focusedPaneId}
					{draggedChatId}
					{previewStore}
					{textScale}
				{onFocusPane}
				{onClosePane}
				{onMaximizePane}
				{onSetRatio}
				{onDropChat}
			/>
		</div>
	</div>
{/if}
