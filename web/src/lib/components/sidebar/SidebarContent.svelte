<script lang="ts">
	import type { NewChatProjectTarget } from '$lib/chat/new-chat/new-chat-seed';
	import { untrack } from 'svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import SidebarChatList from './SidebarChatList.svelte';
	import SidebarBackToTop from './SidebarBackToTop.svelte';
	import { shouldShowSidebarBackToTop } from './sidebar-back-to-top';
	import * as m from '$lib/paraglide/messages.js';
	import type { SidebarChatListProjection } from '../../sidebar/display/sidebar-row-model';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { SidebarOrderController } from '$lib/sidebar/display/sidebar-order-controller.svelte';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from '../../sidebar/display/sidebar-display-options';
	import { registerNativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';

	interface SidebarContentProps {
		reorder: SidebarOrderController;
		projection: SidebarChatListProjection;
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		currentTime: Date;
		searchFilter: string;
		onNewChat?: () => void;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		displayOptions?: SidebarDisplayOptions;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onNewProjectChat?: (project: NewChatProjectTarget) => void;
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
		onSortChatOrder: (sortKey: ChatOrderSortKey) => void;
	}

	let {
		reorder,
		projection,
		selectedChatId,
		isLoading,
		isMobile = false,
		currentTime,
		searchFilter,
		onNewChat,
		isMultiSelectMode,
		isMultiSelected,
		displayOptions = DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		onToggleProjectCollapsed,
		onNewProjectChat,
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
		onSortChatOrder,
	}: SidebarContentProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let measuredViewport = $state<HTMLElement | null>(null);
	let viewportHeight = $state(0);
	let showBackToTop = $state(false);

	$effect(() => {
		const viewport = viewportRef;
		if (!viewport) return;
		return registerNativeWorkspaceScrollRegion(viewport, 'primary');
	});

	$effect(() => {
		const viewport = viewportRef;
		if (!viewport) {
			measuredViewport = null;
			showBackToTop = false;
			return;
		}
		const updateViewport = () => {
			if (viewportRef !== viewport) return;
			const height = viewport.clientHeight;
			viewportHeight = height;
			const nextVisible = shouldShowSidebarBackToTop({
				scrollTop: viewport.scrollTop,
				viewportHeight: height,
				currentlyVisible: showBackToTop,
			});
			if (nextVisible === showBackToTop) return;
			if (
				!nextVisible &&
				viewport.ownerDocument.activeElement?.closest('[data-sidebar-back-to-top]')
			) {
				viewport.focus({ preventScroll: true });
			}
			showBackToTop = nextVisible;
		};

		// Keeps visibility state reads from re-subscribing the DOM lifecycle effect.
		untrack(updateViewport);
		measuredViewport = viewport;
		viewport.addEventListener('scroll', updateViewport, { passive: true });
		const resizeObserver =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateViewport);
		resizeObserver?.observe(viewport);
		return () => {
			viewport.removeEventListener('scroll', updateViewport);
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
		viewportHeight={measuredViewport === viewportRef ? viewportHeight : 0}
		{projection}
		{selectedChatId}
		{isLoading}
		{isMobile}
		{currentTime}
		{searchFilter}
		{onNewChat}
		{isMultiSelectMode}
		{isMultiSelected}
		{displayOptions}
		{onToggleProjectCollapsed}
		{onNewProjectChat}
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
		{reorder}
		{onSortChatOrder}
	/>
</ScrollArea>
