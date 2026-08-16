<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ConversationFeedVirtualRow from './ConversationFeedVirtualRow.svelte';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import {
		getActiveTranscriptState,
		getAgentState,
		getLocalSettings,
		getAppShell,
		getModelCatalog,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import {
		CHAT_FEED_CONTENT_BASE_CLASS,
		CHAT_MAX_WIDTH_FEED_CONTENT_CLASS,
		CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS,
	} from '$lib/chat/conversation/chat-max-width.js';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button';
	import { Scrollbar } from '$lib/components/ui/scroll-area';
	import { cn } from '$lib/utils/cn';
	import { ScrollArea as ScrollAreaPrimitive } from 'bits-ui';
	import {
		canShowForkAtMessageAction,
		canUseForkAtMessageAction,
	} from '$lib/chat/actions/fork-at-message-action.js';
	import { visiblePendingPermissionRequests } from '$lib/chat/transcript/conversation-feed-items.js';
	import {
		conversationScrollbarScrollDirection,
		conversationScrollbarTrackDirection,
		conversationWheelScrollDirection,
	} from '$lib/chat/transcript/conversation-scroll-gesture.js';
	import { ConversationFeedProjectionState } from './ConversationFeedProjectionState.svelte.js';
	import { ConversationFeedRetentionState } from './ConversationFeedRetentionState.svelte.js';
	import { ConversationFeedVirtualController } from './ConversationFeedVirtualController.svelte.js';
	import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
	import { ConversationFeedItemState } from './ConversationFeedItemState.svelte.js';
	import {
		ConversationFeedAnnouncementBatcher,
		ConversationFeedAnnouncerState,
	} from './conversation-feed-announcer.js';

	const EMPTY_PENDING_PERMISSIONS: PendingPermissionRequest[] = [];

	interface Props {
		scrollContainer?: HTMLDivElement | null;
		onscroll?: () => void;
		onUserScrollIntent?: (direction: 'earlier' | 'later' | null) => void;
		onPermissionDecision?: (
			permissionOccurrenceId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
		onExitPlanMode?: (
			permissionOccurrenceId: string,
			choice: string,
			plan: string,
		) => void;
		pendingPermissionRequests?: PendingPermissionRequest[];
		onRetry?: () => void;
		onLoadEarlier?: () => void;
		onLoadLater?: () => void;
		reserveComposerTraySpace?: boolean;
		reserveTopFloatingToolbar?: boolean;
		isPreparingInitialScroll?: boolean;
		textScale?: number;
		isProcessing?: boolean;
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		isVisible: boolean;
		pinnedToBottom: boolean;
		surfaceIdentity: string;
		onViewportPortChange?: (port: ConversationViewportPort | null) => void;
		onRegisterPrepareHide?: (prepare: (() => void) | null) => void;
		onInitialEndRestored?: () => void;
	}

	let {
		scrollContainer = $bindable(null),
		onscroll,
		onUserScrollIntent,
		onPermissionDecision,
		onExitPlanMode,
		pendingPermissionRequests = [],
		onRetry,
		onLoadEarlier = () => {},
		onLoadLater = () => {},
		reserveComposerTraySpace = false,
		reserveTopFloatingToolbar = false,
		isPreparingInitialScroll = false,
		textScale = 1,
		isProcessing = false,
		onForkChat,
		onGenerateTitleFromMessage,
		isVisible,
		pinnedToBottom,
		surfaceIdentity,
		onViewportPortChange,
		onRegisterPrepareHide,
		onInitialEndRestored,
	}: Props = $props();

	const chatState = getActiveTranscriptState();
	const agentState = getAgentState();
	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const modelCatalog = getModelCatalog();

	const supportsForkAtMessage = $derived(modelCatalog.supportsForkAtMessage(agentState.agentId));
	const canShowForkAtMessage = $derived(
		canShowForkAtMessageAction({
			supportsForkAtMessage,
		}),
	);
	const canUseForkAtMessage = $derived(
		canUseForkAtMessageAction({
			supportsForkAtMessage,
			supportsForkWhileRunning: modelCatalog.supportsForkWhileRunning(agentState.agentId),
			isProcessing,
		}),
	);

	function handleMessagePaneFocusIntent() {
		appShell.requestSidebarRecenterToSelected();
	}

	let scrollbarPointerY: number | null = null;

	function handleScrollbarPointerDownCapture(event: PointerEvent): void {
		if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
		const target = event.target instanceof Element ? event.target : null;
		const isThumbPickup = Boolean(target?.closest('[data-slot="scroll-area-thumb"]'));
		scrollbarPointerY = event.clientY;
		if (isThumbPickup) {
			onUserScrollIntent?.(null);
			return;
		}
		const thumbRect = event.currentTarget
			.querySelector<HTMLElement>('[data-slot="scroll-area-thumb"]')
			?.getBoundingClientRect();
		const direction = thumbRect
			? conversationScrollbarTrackDirection(event.clientY, thumbRect.top, thumbRect.bottom)
			: null;
		onUserScrollIntent?.(direction);
	}

	function handleScrollbarPointerMove(event: PointerEvent): void {
		if (scrollbarPointerY === null || (event.buttons & 1) === 0) return;
		const direction = conversationScrollbarScrollDirection(scrollbarPointerY, event.clientY);
		scrollbarPointerY = event.clientY;
		if (direction) onUserScrollIntent?.(direction);
	}

	function handleScrollbarWheel(event: WheelEvent): void {
		const direction = conversationWheelScrollDirection(event.deltaY);
		if (direction) onUserScrollIntent?.(direction);
	}

	function finishScrollbarPointerIntent(): void {
		scrollbarPointerY = null;
	}

	const feedScrollAreaClass = 'h-full overflow-hidden relative';
	const feedViewportClass = $derived(
		cn(
			'h-full overflow-y-auto overflow-x-hidden relative outline-none focus-visible:ring-2 focus-visible:ring-ring',
			CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS[localSettings.chatMaxWidth],
		),
	);
	const feedContentClass = $derived(
		cn(
			CHAT_FEED_CONTENT_BASE_CLASS,
			CHAT_MAX_WIDTH_FEED_CONTENT_CLASS[localSettings.chatMaxWidth],
			chatState.displayMessageCount === 0 && 'pt-3 sm:pt-4',
			chatState.displayMessageCount === 0 && (reserveComposerTraySpace ? 'pb-14' : 'pb-3 sm:pb-4'),
			isPreparingInitialScroll && 'invisible',
		),
	);
	const showEarlierLoadingStatus = $derived(
		!isPreparingInitialScroll &&
			chatState.displayMessageCount > 0 &&
			chatState.pageStates.earlier.status === 'loading' &&
			chatState.pageStates.earlier.error === null,
	);
	const activePendingPermissionRequests = $derived.by(() =>
		pendingPermissionRequests.filter(
			(request) => !request.chatId || request.chatId === chatState.activeChatId,
		),
	);
	const projectedPendingPermissionRequests = $derived(
		visiblePendingPermissionRequests(chatState.visibleRows, activePendingPermissionRequests),
	);
	const projectionState = new ConversationFeedProjectionState();
	const retention = new ConversationFeedRetentionState();
	const itemState = new ConversationFeedItemState();
	const announcerState = new ConversationFeedAnnouncerState();
	let announcement = $state.raw({ sequence: 0, text: '' });
	const announcementBatcher = new ConversationFeedAnnouncementBatcher((text) => {
		announcement = { sequence: announcement.sequence + 1, text };
	});
	const projectionInput = $derived({
		surfaceIdentity,
		rows: chatState.visibleRows,
		mutationClock: chatState.feedMutationClock,
		hiddenToolTypes: localSettings.hiddenToolTypes,
		showThinking: localSettings.showThinking,
		textScale,
		isLiveWindow: !chatState.hasLaterMessages,
		showTopToolbarSpacer: reserveTopFloatingToolbar,
		showRefreshError: chatState.loadStatus === 'error' && chatState.displayMessageCount > 0,
		showEarlierBoundary:
			chatState.pageStates.earlier.status === 'error' ||
			(chatState.pageStates.earlier.status === 'loading' &&
				chatState.pageStates.earlier.error !== null),
		showLaterBoundary: chatState.canLoadLater || chatState.pageStates.later.status !== 'idle',
		reserveComposerTraySpace,
		transcriptViewId: chatState.getCursor().transcriptViewId,
		pendingPermissions:
			projectedPendingPermissionRequests.length > 0 && onPermissionDecision
				? projectedPendingPermissionRequests
				: EMPTY_PENDING_PERMISSIONS,
	});
	let projection = $state.raw(projectionState.reconcile(untrack(() => projectionInput)));
	let virtualRoot: HTMLDivElement | null = $state(null);

	$effect.pre(() => {
		const input = {
			surfaceIdentity,
			rows: chatState.visibleRows,
			mutationClock: chatState.feedMutationClock,
			visible: isVisible,
			pinnedToBottom,
			isLiveWindow: !chatState.hasLaterMessages,
			detachedStatus: m.chat_feed_new_response_available(),
			hiddenToolTypes: localSettings.hiddenToolTypes,
			floatingPermissionOccurrences: projectionInput.pendingPermissions.map(
				(request) => request.permissionOccurrenceId,
			),
		};
		untrack(() => {
			const update = announcerState.reconcileUpdate(input);
			if (update !== null) announcementBatcher.enqueue(update);
		});
	});

	const virtualController = new ConversationFeedVirtualController({
		get model() {
			return projection.model;
		},
		get geometry() {
			return projection.geometry;
		},
		get projectedDataRevision() {
			return projection.projectedDataRevision;
		},
		get viewport() {
			return scrollContainer;
		},
		get virtualRoot() {
			return virtualRoot;
		},
		get visible() {
			return isVisible;
		},
		get pinned() {
			return pinnedToBottom;
		},
		get retention() {
			return retention;
		},
		onInitialEndRestored: () => onInitialEndRestored?.(),
	});
	const virtualizer = virtualController.virtualizer;
	const virtualItems = $derived($virtualizer.getVirtualItems());
	const virtualTotalSize = $derived($virtualizer.getTotalSize());

	$effect.pre(() => {
		const input = projectionInput;
		const pendingPermissionOccurrences = new Set(
			activePendingPermissionRequests.map((request) => request.permissionOccurrenceId),
		);
		untrack(() => {
			const nextProjection = projectionState.reconcile(input);
			// Captures old coordinates before publishing the projection that changes row geometry.
			virtualController.prepareForGeometryPublication(
				nextProjection.geometry.geometryRevision,
				nextProjection.geometry.mutationKinds.has('history-earlier'),
				scrollbarPointerY !== null,
			);
			projection = nextProjection;
			itemState.reconcile(
				input.surfaceIdentity,
				new Set(input.rows.map((row) => row.id)),
				pendingPermissionOccurrences,
			);
		});
	});

	$effect(() => {
		onViewportPortChange?.(virtualController);
		return () => onViewportPortChange?.(null);
	});

	function prepareForHide(): void {
		retention.closeAllTransients();
		virtualController.prepareForHide();
	}

	$effect(() => {
		onRegisterPrepareHide?.(prepareForHide);
		return () => onRegisterPrepareHide?.(null);
	});

	$effect(() =>
		retention.observeSelection({
			get root() {
				return virtualRoot;
			},
			get visible() {
				return isVisible;
			},
		}),
	);

	$effect(() => {
		if (isVisible) return;
		retention.closeAllTransients();
	});

	onDestroy(() => {
		virtualController.destroy();
		retention.clear();
		projectionState.reset();
		itemState.clear();
		announcementBatcher.destroy();
		announcerState.reset();
	});
</script>

{#snippet feedContent()}
	{#if reserveTopFloatingToolbar && chatState.displayMessageCount === 0}
		<div class="h-12" aria-hidden="true" data-chat-top-toolbar-spacer></div>
	{/if}
	{#if chatState.isLoadingMessages && chatState.displayMessageCount === 0}
		<div class="text-center text-muted-foreground mt-8">
			<div class="flex items-center justify-center space-x-2">
				<Loader2 class="h-4 w-4 animate-spin" />
				<p>{m.chat_chat_loading_chat_messages()}</p>
			</div>
		</div>
	{:else if chatState.loadStatus === 'error' && chatState.displayMessageCount === 0}
		<div class="text-center text-muted-foreground mt-8">
			<div class="flex items-center justify-center space-x-2">
				<TriangleAlert class="h-4 w-4 text-destructive" />
				<p class="text-sm">{m.chat_feed_failed_to_load()}</p>
			</div>
			{#if chatState.loadError}
				<p class="text-xs mt-1 text-muted-foreground/70">{chatState.loadError}</p>
			{/if}
			{#if onRetry}
				<Button variant="outline" size="sm" class="mt-3" onclick={onRetry}>
					<RefreshCw class="h-3 w-3 mr-1" />
					{m.chat_feed_retry()}
				</Button>
			{/if}
		</div>
	{:else if chatState.displayMessageCount === 0}
		<div class="text-center text-muted-foreground mt-8">
			<p class="text-sm">{m.chat_messages_no_messages()}</p>
			<p class="text-xs mt-1">{m.chat_messages_send_first_message()}</p>
		</div>
	{:else}
		<div
			bind:this={virtualRoot}
			class="relative w-full"
			style:height={`${virtualTotalSize}px`}
			style="overflow-anchor: none;"
			data-chat-virtual-sizer
			data-chat-virtual-count={virtualItems.length}
			data-chat-virtual-model-count={projection.model.items.length}
			data-chat-virtual-data-revision={projection.projectedDataRevision}
			data-chat-transcript-entry-count={chatState.entries.length}
			data-chat-transcript-scale={String(textScale)}
		>
			{#each virtualItems as virtualItem (virtualItem.key)}
				{@const itemIndex = projection.model.indexByKey.get(String(virtualItem.key))}
				{@const item = itemIndex === undefined ? undefined : projection.model.items[itemIndex]}
				{#if item}
					<ConversationFeedVirtualRow
						{virtualItem}
						{item}
						controller={virtualController}
						{retention}
						{itemState}
						renderModel={projection.renderModel}
						agentId={agentState.agentId}
						showThinking={localSettings.showThinking}
						{textScale}
						{pendingPermissionRequests}
						earlierPageState={chatState.pageStates.earlier}
						laterPageState={chatState.pageStates.later}
						loadError={chatState.loadError}
						{onRetry}
						{onLoadEarlier}
						{onLoadLater}
						{onPermissionDecision}
						{onExitPlanMode}
						onForkChat={canShowForkAtMessage ? onForkChat : undefined}
						{onGenerateTitleFromMessage}
						canForkAtMessageNow={canUseForkAtMessage}
					/>
				{/if}
			{/each}
		</div>
	{/if}
{/snippet}

<ScrollAreaPrimitive.Root type="auto" class={feedScrollAreaClass}>
	{#if isPreparingInitialScroll}
		<div
			class="pointer-events-none absolute inset-x-0 top-8 z-10 flex items-center justify-center text-muted-foreground"
		>
			<div class="flex items-center gap-2 text-sm">
				<Loader2 class="h-4 w-4 animate-spin" />
				<span>{m.chat_chat_loading_chat_messages()}</span>
			</div>
		</div>
	{:else if showEarlierLoadingStatus}
		<!-- Keeps automatic loading outside TanStack geometry so prepends cannot move the reading anchor. -->
		<div
			class={cn(
				'pointer-events-none absolute left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-none',
				reserveTopFloatingToolbar
					? 'top-[calc(var(--workspace-floating-taskbar-inset)+0.5rem)]'
					: 'top-2',
			)}
			role="status"
			aria-live="polite"
			data-chat-earlier-loading-indicator
		>
			<Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
			<span class="sr-only">{m.chat_transcript_loading_earlier()}</span>
		</div>
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -- scroll container needs programmatic focus for Ctrl+U/D; follow-up: CLEANUP_ROUND_TWO.md#a11y-suppression-register -->
	<ScrollAreaPrimitive.Viewport
		bind:ref={scrollContainer}
		{onscroll}
		onfocusin={handleMessagePaneFocusIntent}
		tabindex={-1}
		role="region"
		aria-busy={chatState.isLoadingMessages ||
			isPreparingInitialScroll ||
			chatState.pageStates.earlier.status === 'loading' ||
			chatState.pageStates.later.status === 'loading'}
		aria-live="off"
		aria-label={m.chat_messages_region()}
		data-chat-scroll-viewport
		data-chat-pinned-to-bottom={pinnedToBottom}
		data-chat-user-scrolled-up={chatState.isUserScrolledUp}
		class={feedViewportClass}
	>
		<div class={feedContentClass} data-chat-feed-content>
			{@render feedContent()}
		</div>
	</ScrollAreaPrimitive.Viewport>
	<Scrollbar
		orientation="vertical"
		class={cn('w-1.5', isPreparingInitialScroll && 'invisible')}
		data-chat-feed-scrollbar
		onpointerdowncapture={handleScrollbarPointerDownCapture}
		onwheel={handleScrollbarWheel}
		onpointermove={handleScrollbarPointerMove}
		onpointerup={finishScrollbarPointerIntent}
		onpointercancel={finishScrollbarPointerIntent}
		onlostpointercapture={finishScrollbarPointerIntent}
	/>
	<ScrollAreaPrimitive.Corner />
	<div
		class="sr-only"
		role="status"
		aria-live="polite"
		aria-atomic="true"
		data-chat-feed-announcement-sequence={announcement.sequence}
	>
		{#key announcement.sequence}<span>{announcement.text}</span>{/key}
	</div>
</ScrollAreaPrimitive.Root>
