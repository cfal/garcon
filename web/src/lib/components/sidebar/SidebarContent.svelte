<script lang="ts">
	import { untrack } from 'svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import SidebarChatList from './SidebarChatList.svelte';
	import SidebarBackToTop from './SidebarBackToTop.svelte';
	import { shouldShowSidebarBackToTop } from './sidebar-back-to-top';
	import * as m from '$lib/paraglide/messages.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type {
		PersistedChatOrderGroup,
		RelativeChatOrderPlacement,
	} from '$shared/chat-order-contracts';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from './sidebar-display-options';
	import { registerNativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';

	interface SidebarContentProps {
		chats: ChatSessionRecord[];
		filteredChats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		currentTime: Date;
		searchFilter: string;
		onNewChat?: () => void;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		displayOptions?: SidebarDisplayOptions;
		collapsedProjectKeys?: ReadonlySet<string>;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chat: ChatSessionRecord) => void;
		onStartRenameChat: (chat: ChatSessionRecord) => void;
		onShowDetails: (chat: ChatSessionRecord) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chat: ChatSessionRecord) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chat: ChatSessionRecord) => void;
		onOpenInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
		newWindowEdges: WorkspaceSplitAdmissions;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		isArchiveMutationPending?: (chatId: string) => boolean;
		isChatOptimisticallyArchived?: (chatId: string) => boolean;
		onQuickMove: (
			list: PersistedChatOrderGroup,
			chatId: string,
			placement: RelativeChatOrderPlacement,
			onSuccess?: () => void,
			onFailure?: () => void,
		) => void;
		onSortChatOrder: (sortKey: ChatOrderSortKey) => void;
	}

	let {
		chats,
		filteredChats,
		selectedChatId,
		isLoading,
		isMobile = false,
		currentTime,
		searchFilter,
		onNewChat,
		isMultiSelectMode,
		isMultiSelected,
		displayOptions = DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		collapsedProjectKeys = new Set<string>(),
		onToggleProjectCollapsed,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onChatSelect,
		onDeleteChat,
		onStartRenameChat,
		onShowDetails,
		onForkChat,
		onShareChat,
		onTagClick,
		onManageTags,
		onOpenInNewWindow,
		newWindowEdges,
		onTogglePinned,
		onToggleArchive,
		isArchiveMutationPending = () => false,
		isChatOptimisticallyArchived = () => false,
		onQuickMove,
		onSortChatOrder,
	}: SidebarContentProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let showBackToTop = $state(false);

	$effect(() => {
		const viewport = viewportRef;
		if (!viewport) return;
		return registerNativeWorkspaceScrollRegion(viewport, 'primary');
	});

	$effect(() => {
		const viewport = viewportRef;
		if (!viewport) {
			showBackToTop = false;
			return;
		}
		const scrollViewport: HTMLElement = viewport;

		function updateVisibility(): void {
			const nextVisible = shouldShowSidebarBackToTop({
				scrollTop: scrollViewport.scrollTop,
				viewportHeight: scrollViewport.clientHeight,
				currentlyVisible: showBackToTop,
			});
			if (nextVisible === showBackToTop) return;
			if (
				!nextVisible &&
				scrollViewport.ownerDocument.activeElement?.closest('[data-sidebar-back-to-top]')
			) {
				scrollViewport.focus({ preventScroll: true });
			}
			showBackToTop = nextVisible;
		}

		// Keeps visibility state reads from re-subscribing the DOM lifecycle effect.
		untrack(updateVisibility);
		scrollViewport.addEventListener('scroll', updateVisibility, { passive: true });
		const resizeObserver =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateVisibility);
		resizeObserver?.observe(scrollViewport);
		return () => {
			scrollViewport.removeEventListener('scroll', updateVisibility);
			resizeObserver?.disconnect();
		};
	});

	function scrollBackToTop(): void {
		const viewport = viewportRef;
		if (!viewport) return;
		viewport.scrollTo({ top: 0, behavior: 'auto' });
		viewport.focus({ preventScroll: true });
	}
</script>

{#snippet backToTopOverlay()}
	{#if showBackToTop}
		<SidebarBackToTop {isMobile} onActivate={scrollBackToTop} />
	{/if}
{/snippet}

<ScrollArea
	bind:viewportRef
	class="flex-1 overflow-y-auto overscroll-contain"
	scrollbarYClasses="w-1.5"
	viewportAttributes={{
		tabindex: -1,
		role: 'region',
		'aria-label': m.sidebar_chats_region(),
	}}
	overlay={backToTopOverlay}
>
	<SidebarChatList
		{viewportRef}
		{chats}
		{filteredChats}
		{selectedChatId}
		{isLoading}
		{isMobile}
		{currentTime}
		{searchFilter}
		{onNewChat}
		{isMultiSelectMode}
		{isMultiSelected}
		{displayOptions}
		{collapsedProjectKeys}
		{onToggleProjectCollapsed}
		{onEnterMultiSelect}
		{onMultiSelectToggle}
		{onChatSelect}
		{onDeleteChat}
		{onStartRenameChat}
		{onShowDetails}
		{onForkChat}
		{onShareChat}
		{onTagClick}
		{onManageTags}
		{onOpenInNewWindow}
		{newWindowEdges}
		{onTogglePinned}
		{onToggleArchive}
		{isArchiveMutationPending}
		{isChatOptimisticallyArchived}
		{onQuickMove}
		{onSortChatOrder}
	/>
</ScrollArea>
