<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { ChatBoardOccurrence } from '$lib/chat-board/projection/chat-board-projection.js';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import type { ChatTagConfirmationKind } from '$lib/chat/sessions/chat-sessions-contract.js';
	import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
	import {
		virtualItems as selectVirtualItems,
		type VirtualMutationAnchor,
		type VirtualRange,
	} from '$lib/virt/virtual-list-types.js';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import ChatBoardCard from './ChatBoardCard.svelte';
	import { isChatBoardCardDragData } from './chat-board-dnd.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		columnId,
		boardId,
		instanceId,
		occurrences,
		layout,
		canDrag,
		pendingChatIds,
		tagConfirmationKind,
		canTransition,
		onOpen,
		onTransition,
		onConfirmTags,
		onRegisterScroller,
		initialScrollTop,
		onScrollTopChange,
	}: {
		columnId: string;
		boardId: string;
		instanceId: string;
		occurrences: readonly ChatBoardOccurrence[];
		layout: ChatItemLayout;
		canDrag: boolean;
		pendingChatIds: ReadonlySet<string>;
		tagConfirmationKind: (chatId: string) => ChatTagConfirmationKind;
		canTransition: boolean;
		onOpen: (chatId: string) => void;
		onTransition: (occurrence: ChatBoardOccurrence, invoker: HTMLElement) => void;
		onConfirmTags: (chatId: string) => void;
		onRegisterScroller?: (columnId: string, scroll: ((key: string) => void) | null) => void;
		initialScrollTop: number;
		onScrollTopChange: (boardId: string, columnId: string, scrollTop: number) => void;
	} = $props();

	const mountedBoardId = untrack(() => boardId);
	const mountedColumnId = untrack(() => columnId);
	const scrollRegion = nativeWorkspaceScrollRegion('contextual');
	const virtual = new VirtualListController({
		initialViewportSize: 720,
		get overscan() {
			return 6;
		},
		get measurementAnchor() {
			return 'geometric' as const;
		},
	});
	let viewportRef = $state<HTMLDivElement | null>(null);

	function estimatedRowHeight(itemLayout: ChatItemLayout): number {
		switch (itemLayout) {
			case 'single-line':
				return 53;
			case 'compact':
				return 81;
			case 'detailed':
				return 129;
		}
	}

	let estimate = $derived(estimatedRowHeight(layout));
	let snapshot = $derived(virtual.snapshot);
	let virtualItems = $derived(selectVirtualItems(snapshot, indexesInRange(snapshot.overscanRange)));
	let renderedItems = $derived.by(() => {
		if (virtualItems.length > 0 || occurrences.length === 0) return virtualItems;
		return occurrences.slice(0, 18).map((occurrence, index) => ({
			index,
			key: occurrence.key,
			start: index * estimate,
			size: estimate,
			end: (index + 1) * estimate,
		}));
	});

	$effect.pre(() => {
		const keys = occurrences.map((occurrence) => occurrence.key);
		const nextEstimate = estimate;
		untrack(() => {
			virtual.apply({
				kind: 'update',
				keys,
				estimates: keys.map(() => nextEstimate),
				anchor: currentAnchor(),
			});
		});
	});

	$effect(() => {
		onRegisterScroller?.(columnId, (key) => {
			virtual.scrollToKey(key, { align: 'center' });
		});
		return () => onRegisterScroller?.(columnId, null);
	});

	$effect(() => {
		if (!viewportRef) return;
		viewportRef.scrollTop = initialScrollTop;
		virtual.refreshLayout();
	});

	$effect(() => {
		if (!canDrag || !viewportRef) return;
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void import('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element').then((module) => {
			if (disposed || !viewportRef) return;
			cleanup = module.autoScrollForElements({
				element: viewportRef,
				canScroll: ({ source }) =>
					isChatBoardCardDragData(source.data) && source.data.instanceId === instanceId,
				getAllowedAxis: () => 'vertical',
			});
		});
		return () => {
			disposed = true;
			cleanup?.();
		};
	});

	function indexesInRange(range: VirtualRange | null): number[] {
		return range
			? Array.from(
					{ length: range.endIndex - range.startIndex + 1 },
					(_, offset) => range.startIndex + offset,
				)
			: [];
	}

	function currentAnchor(): VirtualMutationAnchor {
		const position = virtual.viewportPosition;
		const item = position
			? virtual.snapshot.positions.itemAtOffset(position.paintedOffset)
			: undefined;
		return item ? { kind: 'item', key: item.key } : { kind: 'none' };
	}

	function rememberScrollPosition(): void {
		const viewport = viewportRef;
		if (!viewport?.isConnected) return;
		onScrollTopChange(mountedBoardId, mountedColumnId, viewport.scrollTop);
	}

	onDestroy(() => {
		rememberScrollPosition();
		virtual.destroy();
	});
</script>

<div
	bind:this={viewportRef}
	{@attach virtual.viewport}
	{@attach scrollRegion}
	class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
	style:overflow-anchor="none"
	data-chat-board-lane-list={columnId}
	onscroll={rememberScrollPosition}
>
	{#if occurrences.length === 0}
		<div class="grid min-h-40 place-items-center px-4 text-center">
			<p class="text-xs text-foreground/70">{m.chat_board_empty_column()}</p>
		</div>
	{:else}
		<div
			class="relative w-full"
			style:height={`${snapshot.sizerSize}px`}
			{@attach virtual.sizer}
			data-chat-board-lane-sizer
		>
			{#each renderedItems as virtualItem (virtualItem.key)}
				{@const occurrence = occurrences[virtualItem.index]}
				{#if occurrence}
					<div
						class="absolute left-0 top-0 w-full pb-2"
						style:transform={`translateY(${virtualItem.start}px)`}
						{@attach virtual.item(virtualItem.key)}
					>
						<svelte:boundary>
							<ChatBoardCard
								{occurrence}
								{layout}
								{instanceId}
								{boardId}
								{canDrag}
								pending={pendingChatIds.has(occurrence.chat.id)}
								confirmationKind={tagConfirmationKind(occurrence.chat.id)}
								{canTransition}
								occurrenceIndex={virtualItem.index}
								{onOpen}
								{onTransition}
								{onConfirmTags}
							/>
							{#snippet failed()}
								<button
									type="button"
									class="w-full rounded-lg border border-status-error-border bg-status-error px-3 py-3 text-left text-xs text-status-error-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onclick={() => onOpen(occurrence.chat.id)}
								>
									{m.chat_board_chat_unavailable()}
								</button>
							{/snippet}
						</svelte:boundary>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
