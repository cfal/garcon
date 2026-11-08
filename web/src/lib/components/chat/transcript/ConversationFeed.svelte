<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import ConversationFeedVirtualRow from './ConversationFeedVirtualRow.svelte';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import { getLocalSettings, getModelCatalog } from '$lib/context';
	import type { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
	import type { ConversationFeedPresentationPort } from '$lib/chat/transcript/conversation-feed-presentation-port.js';
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
	import { HIDEABLE_TOOL_GROUPS } from '$shared/transcript-display-policy';
	import type { GroupDescriptor, MemberWindowRequest } from '$shared/transcript-display-contract';
	import { DisplayCoverage } from '$lib/chat/transcript/display-coverage.js';
	import { expansionFor } from '$lib/chat/transcript/display-window-controller.js';
	import { nextConversationCoverage } from './conversation-feed-coverage.js';
	import { groupContainingRow } from './conversation-feed-virtual-items.js';
	import {
		conversationScrollbarScrollDirection,
		conversationScrollbarTrackDirection,
		conversationWheelScrollDirection,
	} from '$lib/chat/transcript/conversation-scroll-gesture.js';
	import {
		ConversationFeedProjectionState,
		type ConversationFeedProjectionInput,
	} from './ConversationFeedProjectionState.svelte.js';
	import { ConversationFeedRetentionState } from './ConversationFeedRetentionState.svelte.js';
	import { ConversationFeedVirtualController } from './ConversationFeedVirtualController.svelte.js';
	import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
	import { ConversationFeedItemState } from './ConversationFeedItemState.svelte.js';
	import { virtualItems as selectVirtualItems } from '$lib/virt/virtual-list-types.js';
	import {
		ConversationFeedAnnouncementBatcher,
		ConversationFeedAnnouncerState,
	} from './conversation-feed-announcer.js';

	const EMPTY_PENDING_PERMISSIONS: PendingPermissionRequest[] = [];

	interface Props {
		chatContext: ConversationMessageChatContext;
		transcript: ActiveTranscriptState;
		agentId: SessionAgentId;
		scrollContainer?: HTMLDivElement | null;
		onscroll?: () => void;
		onUserScrollIntent?: (direction: 'earlier' | 'later' | null) => void;
		onPermissionDecision?: (
			permissionOccurrenceId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
		onExitPlanMode?: (permissionOccurrenceId: string, choice: string, plan: string) => void;
		pendingPermissionRequests?: readonly PendingPermissionRequest[];
		onRetry?: () => void;
		onLoadEarlier?: () => void;
		onLoadLater?: () => void;
		reserveComposerCapSpace?: boolean;
		isPreparingInitialScroll?: boolean;
		isProcessing?: boolean;
		onForkChat?: (upToSeq?: number) => void;
		onClearBefore?: (ordinal: number) => void;
		onAppendToDraft?: (block: string) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		isVisible: boolean;
		announcementsEnabled?: boolean;
		pinnedToBottom: boolean;
		surfaceIdentity: string;
		onViewportPortChange?: (port: ConversationViewportPort | null) => void;
		onRegisterPrepareHide?: (prepare: (() => void) | null) => void;
		onPresentationPortChange?: (port: ConversationFeedPresentationPort | null) => void;
		onInitialEndRestored?: () => void;
	}

	let {
		chatContext,
		transcript,
		agentId,
		scrollContainer = $bindable(null),
		onscroll,
		onUserScrollIntent,
		onPermissionDecision,
		onExitPlanMode,
		pendingPermissionRequests = [],
		onRetry,
		onLoadEarlier = () => {},
		onLoadLater = () => {},
		reserveComposerCapSpace = false,
		isPreparingInitialScroll = false,
		isProcessing = false,
		onForkChat,
		onClearBefore,
		onAppendToDraft,
		onGenerateTitleFromMessage,
		isVisible,
		announcementsEnabled = true,
		pinnedToBottom,
		surfaceIdentity,
		onViewportPortChange,
		onRegisterPrepareHide,
		onPresentationPortChange,
		onInitialEndRestored,
	}: Props = $props();

	const chatState = $derived(transcript);
	const localSettings = getLocalSettings();
	const rootModelCatalog = getModelCatalog();
	const modelCatalog = $derived(rootModelCatalog.forExecutor(chatContext.executorId));

	const supportsForkAtMessage = $derived(modelCatalog.supportsForkAtMessage(agentId));
	const canClearBefore = $derived(modelCatalog.getAgent(agentId)?.executionPolicy === 'literal');
	const canShowForkAtMessage = $derived(
		canShowForkAtMessageAction({
			supportsForkAtMessage,
		}),
	);
	const canUseForkAtMessage = $derived(
		canUseForkAtMessageAction({
			supportsForkAtMessage,
			supportsForkWhileRunning: modelCatalog.supportsForkWhileRunning(agentId),
			isProcessing,
		}),
	);

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
		virtualController.finishScrollbarDrag();
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
			chatState.displayMessageCount > 0 && 'min-h-full justify-end',
			chatState.displayMessageCount === 0 && 'pt-3 sm:pt-4',
			chatState.displayMessageCount === 0 && (reserveComposerCapSpace ? 'pb-14' : 'pb-3 sm:pb-4'),
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
	const projectionState = new ConversationFeedProjectionState();
	const retention = new ConversationFeedRetentionState();
	const itemState = new ConversationFeedItemState();

	async function revealToolGroup(rowId: string): Promise<'applied' | 'cancelled'> {
		const group = groupContainingRow(projection.model, rowId);
		if (!group) return 'cancelled';
		const ordinal = Number(rowId.slice(chatState.transcriptViewId.length + 1));
		const result = await chatState.expandGroup(group.descriptor, { kind: 'around', ordinal });
		await tick();
		return result === 'loaded' ? 'applied' : 'cancelled';
	}

	function toggleToolGroup(group: GroupDescriptor, expanded: boolean): void {
		if (expanded) void chatState.expandGroup(group);
		else {
			retention.closeAllTransients();
			chatState.collapseGroup(group);
		}
	}

	function loadMembers(group: GroupDescriptor, anchor: MemberWindowRequest['anchor']): void {
		void chatState.controller.extendMembers(group, anchor);
	}

	const announcerState = new ConversationFeedAnnouncerState();
	let announcement = $state.raw({ sequence: 0, text: '' });
	const announcementBatcher = new ConversationFeedAnnouncementBatcher((text) => {
		announcement = { sequence: announcement.sequence + 1, text };
	});
	const displayProfile = $derived({
		combine: localSettings.combineToolUseMessages,
		showThinking: localSettings.showThinking,
		hiddenToolGroups: HIDEABLE_TOOL_GROUPS.filter(group =>
			group.toolTypes.some(type => localSettings.hiddenToolTypes.includes(type))).map(group => group.id),
	});
	$effect(() => {
		const profile = displayProfile;
		const cuts = activePendingPermissionRequests.flatMap(request =>
			request.transcript?.transcriptViewId === chatState.transcriptViewId
				? [{ id: `permission:${request.permissionOccurrenceId}`, afterOrdinal: request.transcript.afterOrdinal, anchorRule: 'eligible-row' as const }]
				: []);
		untrack(() => chatState.configureDisplay(profile, cuts));
	});

	const projectionInput: ConversationFeedProjectionInput = $derived({
		surfaceIdentity,
		display: chatState.display,
		renderModel: chatState.renderModel,
		overlays: chatState.overlayRows,
		optimisticAfterOrdinals: chatState.optimisticAfterOrdinals,
		mutationClock: chatState.feedMutationClock,
		isLiveWindow: !chatState.hasLaterMessages,
		showRefreshError: chatState.loadStatus === 'error',
		earlierBoundary: chatState.pageStates.earlier.error || chatState.canLoadEarlier && !showEarlierLoadingStatus ? 'visible' : 'hidden',
		showLaterBoundary: chatState.hasLaterMessages,
		reserveComposerCapSpace,
		transcriptViewId: chatState.transcriptViewId,
		pendingPermissions: onPermissionDecision ? activePendingPermissionRequests : EMPTY_PENDING_PERMISSIONS,
	});
	let projection = $state.raw(projectionState.reconcile(untrack(() => projectionInput)));
	let virtualRoot: HTMLDivElement | null = $state(null);

	$effect.pre(() => {
		const input = {
			surfaceIdentity,
			rows: chatState.visibleRows,
			watermark: chatState.loadedThroughOrdinal,
			initialHead: chatState.openSnapshot?.sourceHead ?? 0,
			sourceHead: chatState.lastOrdinal,
			announcementOrdinals: chatState.announcementOrdinals,
			profile: displayProfile,
			collapsedGroups: chatState.display.window?.items.filter((item): item is GroupDescriptor =>
				item.kind === 'tool-group' && !expansionFor(item, chatState.display.expansions)) ?? [],
			visible: isVisible && announcementsEnabled,
			pinnedToBottom,
			detachedStatus: m.chat_feed_new_response_available(),
			floatingPermissionOccurrences: projectionInput.pendingPermissions.map(
				(request) => request.permissionOccurrenceId,
			),
		};
		untrack(() => {
			const update = announcerState.reconcileUpdate(input);
			if (update !== null) announcementBatcher.enqueue(update);
		});
	});

	let coverage: DisplayCoverage | undefined;
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
		onTransaction: () => coverage?.wake(),
		onCoverageRequested: () => coverage?.wake(),
		revealToolGroup,
		revealRowDetail: rowId => itemState.disclosurePort(rowId).setOpen('tool-result', 'attached', true, false),
	});
	const virtualSnapshot = $derived(virtualController.snapshot);
	const renderedIndexes = $derived(virtualController.renderedIndexes(virtualSnapshot));
	const virtualItems = $derived(selectVirtualItems(virtualSnapshot, renderedIndexes));

	$effect.pre(() => {
		const input = projectionInput;
		const pendingPermissionOccurrences = new Set(
			activePendingPermissionRequests.map((request) => request.permissionOccurrenceId),
		);
		untrack(() => {
			const nextProjection = projectionState.reconcile(input);
			const applied = virtualController.applyProjection({
				next: nextProjection,
				pinned: pinnedToBottom,
				scrollbarDragActive: scrollbarPointerY !== null,
			});
			if (!applied) {
				return;
			}
			projection = nextProjection;
			itemState.reconcile(
				input.surfaceIdentity,
				new Set([...input.renderModel.items, ...input.overlays].map((row) => row.id)),
				pendingPermissionOccurrences,
			);
		});
	});

	coverage = new DisplayCoverage({
		isVisible: () => isVisible,
		measure: async () => {
			if (chatState.controller.busy || !chatState.display.window || virtualController.ownsScrollPosition()) return { kind: 'waiting' };
			if (chatState.display.window.items.length === 0) return { kind: 'settled', covered: false };
			const result = await virtualController.waitForLayout({ minimumDataRevision: projection.projectedDataRevision });
			if (result !== 'settled') return { kind: result === 'superseded' ? 'superseded' : 'waiting' };
			const fill = await virtualController.measureViewportFill();
			const direction = pinnedToBottom ? 'earlier' : virtualController.readingDirection;
			const range = virtualController.snapshot.visibleRange;
			const exposedMemberBoundary = range && projection.model.items.slice(range.startIndex, range.endIndex + 1)
				.some(item => item.kind === 'member-boundary' && item.anchor.kind === (direction === 'earlier' ? 'before' : 'after'));
			return fill === 'unsettled' ? { kind: 'waiting' } : { kind: 'settled', covered: fill === 'overflow' && !exposedMemberBoundary };
		},
		load: () => {
			if (chatState.display.phase === 'failed') return Promise.resolve('failed');
			if (chatState.display.phase !== 'available') return Promise.resolve('blocked');
			const demand = nextConversationCoverage(projection.model, virtualSnapshot.visibleRange,
				pinnedToBottom ? 'earlier' : virtualController.readingDirection,
				{ earlier: chatState.canLoadEarlier, later: chatState.hasLaterMessages });
			if (!demand) return Promise.resolve('exhausted');
			return typeof demand === 'string' ? chatState.controller.load(demand)
				: chatState.controller.extendMembers(demand.group, demand.anchor);
		},
	});

	$effect(() => {
		chatState.display.revision;
		isVisible;
		virtualSnapshot.revision;
		untrack(() => coverage?.wake());
	});

	$effect(() => {
		const keys = retention.retainedKeys;
		const range = virtualSnapshot.visibleRange;
		const model = projection.model;
		const transcript = chatState;
		const pinned = pinnedToBottom;
		untrack(() => {
			const groups: number[] = [];
			const ordinals = keys.flatMap(key => {
				const index = model.indexByKey.get(key);
				const item = index === undefined ? undefined : model.items[index];
				if (item?.kind === 'tool-group') groups.push(item.descriptor.firstMember);
				return item?.kind === 'transcript' && item.item.kind === 'message' && item.item.ordinal !== undefined ? [item.item.ordinal] : [];
			});
			transcript.controller.protect(ordinals);
			transcript.controller.protectGroups(groups);
			const target = virtualController.captureRestoreTarget(transcript.transcriptViewId, pinned);
			if (target) transcript.controller.setReadingAnchor(target.kind !== 'end' ? target.ordinal : null, pinned);
		});
		if (!range || virtualController.ownsScrollPosition() || !isVisible) return;
		let cancelled = false;
		void virtualController.waitForLayout().then(result => {
			if (cancelled || result !== 'settled' || virtualController.ownsScrollPosition()) return;
			const visibleItems = model.items.slice(range.startIndex, range.endIndex + 1);
			const ordinals: number[] = [];
			const rows: number[] = [];
			for (const item of visibleItems) {
				if (item.kind === 'tool-group') {
					ordinals.push(item.descriptor.firstMember, item.descriptor.lastMember);
				} else if (item.kind === 'transcript' && item.item.kind === 'message' && item.item.ordinal !== undefined) {
					ordinals.push(item.item.ordinal);
					rows.push(item.item.ordinal);
				}
			}
			if (ordinals.length) {
				transcript.controller.trim(Math.min(...ordinals), Math.max(...ordinals), rows);
			}
		});
		return () => { cancelled = true; };
	});

	$effect(() => {
		onViewportPortChange?.(virtualController);
		return () => onViewportPortChange?.(null);
	});

	function prepareForHide(): void {
		retention.closeAllTransients();
		virtualController.prepareForHide();
	}

	function closeTransients(): void {
		retention.closeAllTransients();
	}

	$effect(() => {
		const port: ConversationFeedPresentationPort = {
			captureRestoreTarget: () =>
				virtualController.captureRestoreTarget(chatState.transcriptViewId, pinnedToBottom),
			closeTransients,
		};
		onPresentationPortChange?.(port);
		return () => onPresentationPortChange?.(null);
	});

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
		coverage?.dispose();
		virtualController.destroy();
		retention.clear();
		projectionState.reset();
		itemState.clear();
		announcementBatcher.destroy();
		announcerState.reset();
	});
</script>

{#snippet feedContent()}
	{#if (chatState.isLoadingMessages || !chatState.display.window && chatState.loadStatus !== 'error') && chatState.displayMessageCount === 0 && activePendingPermissionRequests.length === 0}
		<div class="text-center text-muted-foreground mt-8">
			<div class="flex items-center justify-center space-x-2">
				<Loader2 class="h-4 w-4 animate-spin" />
				<p>{m.chat_chat_loading_chat_messages()}</p>
			</div>
		</div>
	{:else if chatState.loadStatus === 'error' && chatState.displayMessageCount === 0 && activePendingPermissionRequests.length === 0}
		<div class="text-center text-muted-foreground mt-8">
			<div class="flex items-center justify-center space-x-2">
				<TriangleAlert class="h-4 w-4 text-destructive" />
				<p class="text-sm">{chatState.loadErrorCode === 'TRANSCRIPT_UNAVAILABLE' ? m.chat_history_unavailable() : m.chat_feed_failed_to_load()}</p>
			</div>
			{#if chatState.loadError}
				<p class="text-xs mt-1 text-muted-foreground/70">{chatState.loadError}</p>
			{/if}
			{#if onRetry && chatState.canRetryLoad}
				<Button variant="outline" size="sm" class="mt-3" onclick={onRetry}>
					<RefreshCw class="h-3 w-3 mr-1" />
					{m.chat_feed_retry()}
				</Button>
			{/if}
		</div>
	{:else if chatState.display.window && chatState.displayMessageCount === 0 && activePendingPermissionRequests.length === 0}
		<div class="text-center text-muted-foreground mt-8">
			<p class="text-sm">{m.chat_messages_no_messages()}</p>
			<p class="text-xs mt-1">{m.chat_messages_send_first_message()}</p>
		</div>
	{:else}
		<div
			bind:this={virtualRoot}
			class="relative w-full"
			style:height={`${virtualSnapshot.sizerSize}px`}
			style="overflow-anchor: none;"
			data-chat-virtual-sizer
			data-chat-virtual-count={virtualItems.length}
			data-chat-virtual-model-count={projection.model.items.length}
			data-chat-virtual-data-revision={projection.projectedDataRevision}
			data-chat-mutation-revisions={JSON.stringify(chatState.feedMutationClock.lastRevisionByKind)}
			data-chat-display-view={chatState.display.window?.certificate.transcriptViewId}
			data-chat-display-watermark={chatState.loadedThroughOrdinal}
			data-chat-display-details-watermark={chatState.display.detailsCertificate?.watermark}
			data-chat-display-after={chatState.display.window?.interval.after}
			data-chat-display-through={chatState.display.window?.interval.through}
			data-chat-transcript-entry-count={chatState.entries.length}
			{@attach virtualController.sizer}
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
						{pendingPermissionRequests}
						{chatContext}
						earlierPageState={chatState.pageStates.earlier}
						laterPageState={chatState.pageStates.later}
						loadError={chatState.loadError}
						loadErrorCode={chatState.loadErrorCode}
						onRetry={chatState.canRetryLoad ? onRetry : undefined}
						{onLoadEarlier}
						{onLoadLater}
						{onPermissionDecision}
						{onExitPlanMode}
						onForkChat={canShowForkAtMessage ? onForkChat : undefined}
						onClearBefore={canClearBefore ? onClearBefore : undefined}
						{onAppendToDraft}
						{onGenerateTitleFromMessage}
						canForkAtMessageNow={canUseForkAtMessage}
						onToggleToolGroup={toggleToolGroup}
						onLoadMembers={loadMembers}
					/>
				{/if}
			{/each}
		</div>
	{/if}
{/snippet}

<ScrollAreaPrimitive.Root
	type={localSettings.autoHideChatScrollbar ? 'scroll' : 'auto'}
	class={feedScrollAreaClass}
	data-chat-scrollbar-auto-hide={localSettings.autoHideChatScrollbar}
>
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
		<!-- Keeps automatic loading outside virtual geometry so prepends cannot move the reading anchor. -->
		<div
			class="pointer-events-none absolute left-1/2 top-2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-none"
			role={announcementsEnabled ? 'status' : undefined}
			aria-live={announcementsEnabled ? 'polite' : 'off'}
			data-chat-earlier-loading-indicator
		>
			<Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
			<span class="sr-only">{m.chat_transcript_loading_earlier()}</span>
		</div>
	{/if}
	<ScrollAreaPrimitive.Viewport
		bind:ref={scrollContainer}
		{onscroll}
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
		{@attach virtualController.viewport}
	>
		<div class={feedContentClass} data-chat-feed-content>
			{@render feedContent()}
		</div>
	</ScrollAreaPrimitive.Viewport>
	<Scrollbar
		orientation="vertical"
		forceMount={localSettings.autoHideChatScrollbar}
		class={cn('w-1.5 pointer-fine:w-3', isPreparingInitialScroll && 'invisible')}
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
		role={announcementsEnabled ? 'status' : undefined}
		aria-live={announcementsEnabled ? 'polite' : 'off'}
		aria-atomic="true"
		data-chat-feed-announcement-sequence={announcement.sequence}
	>
		{#key announcement.sequence}<span>{announcement.text}</span>{/key}
	</div>
</ScrollAreaPrimitive.Root>

<style>
	:global([data-chat-scrollbar-auto-hide='true'] [data-chat-feed-scrollbar]) {
		opacity: 0;
		pointer-events: none;
	}

	:global(
		[data-chat-scrollbar-auto-hide='true']
			[data-chat-feed-scrollbar]:is([data-state='visible'], :active)
	),
	:global([data-chat-scrollbar-auto-hide='true']:has(:focus-visible) [data-chat-feed-scrollbar]) {
		opacity: 1;
		pointer-events: auto;
	}

	@media (hover: hover) and (pointer: fine) {
		:global([data-chat-scrollbar-auto-hide='true']:hover [data-chat-feed-scrollbar]) {
			opacity: 1;
			pointer-events: auto;
		}
	}

	/* Forced mounting keeps drag capture intact, but an empty track must not intercept input. */
	:global(
		[data-chat-scrollbar-auto-hide='true']
			[data-chat-feed-scrollbar]:not(:has([data-scroll-area-thumb]))
	) {
		pointer-events: none;
	}
</style>
