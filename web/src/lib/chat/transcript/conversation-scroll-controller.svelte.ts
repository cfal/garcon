// Scroll viewport controller for the chat conversation pane. Manages
// near-bottom detection, pinned-to-bottom state, infinite scroll
// loading, and layout resize reconciliation.

import { tick } from 'svelte';
import { reconcileScrollAfterHeightDelta } from '$lib/chat/transcript/scroll-anchor.js';
import {
	captureViewportAnchor,
	restoreEarlierHeightFallback,
	restoreViewportAnchor,
	type ViewportAnchor,
} from '$lib/chat/transcript/viewport-anchor.js';
import type {
	ActiveTranscriptState,
	TranscriptPageDirection,
	TranscriptPageLoadResult,
	TranscriptWindowTarget,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { UserMessageNavigatorTarget } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';

const USER_SCROLL_INTENT_WINDOW_MS = 2_000;
const PAGE_BOUNDARY_THRESHOLD_PX = 100;

type PageRequestReason = 'scroll' | 'button';

interface UserScrollIntent {
	epoch: number;
	direction: TranscriptPageDirection | null;
	receivedAt: number;
}

export type ConversationScrollState = Pick<
	ActiveTranscriptState,
	| 'compactToRecentMessages'
	| 'canAutoFillEarlier'
	| 'canLoadEarlier'
	| 'canLoadLater'
	| 'displayMessageCount'
	| 'generationId'
	| 'hasInitialMessagesToReveal'
	| 'hasLaterMessages'
	| 'isLoadingMessages'
	| 'isUserScrolledUp'
	| 'invalidatePendingHistoryLoad'
	| 'loadEarlierPage'
	| 'loadLaterPage'
	| 'loadStatus'
	| 'navigateToWindow'
	| 'pageStates'
	| 'revealEarlierLoadedRows'
>;

export interface ScrollControllerDeps {
	getScrollContainer: () => HTMLDivElement | null;
	getScrollContentContainer?: () => HTMLDivElement | null;
	getQueueContainer: () => HTMLDivElement | undefined;
	chatState: ConversationScrollState;
	sessions: { selectedChatId: string | null };
}

export class ConversationScrollController {
	isPinnedToBottom = $state(true);
	isScrollingToTop = $state(false);
	#isAutoFillingViewport = false;
	#isViewportVisible = true;
	#restoreBottomOnNextVisible = false;
	#suppressNextVisibleBottomRestore = false;
	#bottomRestoreFrame: number | null = null;
	#userScrollIntent: UserScrollIntent = { epoch: 0, direction: null, receivedAt: 0 };
	#consumedIntentEpoch: Record<TranscriptPageDirection, number> = { earlier: 0, later: 0 };
	#boundaryArmed: Record<TranscriptPageDirection, boolean> = { earlier: true, later: true };
	#followLiveRequiresIntentAfter = 0;
	#previousScrollTop: number | null = null;
	#readingAnchor: ViewportAnchor | null = null;
	#initialBottomRestoreChatId = $state<string | null>(null);
	#anchorOperationEpoch = 0;
	#isPageMutationInProgress = false;

	constructor(private deps: ScrollControllerDeps) {}

	isNearBottom(): boolean {
		const node = this.deps.getScrollContainer();
		if (!node) return false;
		const { scrollTop, scrollHeight, clientHeight } = node;
		return scrollHeight - scrollTop - clientHeight < 50;
	}

	get isPreparingInitialScroll(): boolean {
		return (
			this.#initialBottomRestoreChatId === this.deps.sessions.selectedChatId &&
			this.deps.chatState.displayMessageCount > 0 &&
			!this.deps.chatState.isUserScrolledUp
		);
	}

	scrollToBottom(): void {
		const node = this.deps.getScrollContainer();
		if (!node) return;
		node.scrollTop = node.scrollHeight;
		this.#previousScrollTop = node.scrollTop;
		this.#readingAnchor = null;
		this.deps.chatState.isUserScrolledUp = false;
		this.setPinnedToBottom(true);
	}

	async scrollToLatest(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId) return;
		if (!this.deps.chatState.hasLaterMessages && !this.isScrollingToTop) {
			this.scrollToBottom();
			this.deps.chatState.compactToRecentMessages();
			return;
		}
		if (!(await this.#navigateToWindow(chatId, 'latest'))) return;
		this.scrollToBottom();
		this.deps.chatState.compactToRecentMessages();
	}

	async restoreLatestWindow(chatId: string): Promise<boolean> {
		if (!(await this.#navigateToWindow(chatId, 'latest'))) return false;
		this.#preserveHistoryBrowsing();
		return true;
	}

	setPinnedToBottom(isPinned: boolean): void {
		this.isPinnedToBottom = isPinned;
	}

	noteUserScrollIntent(direction: TranscriptPageDirection | null = null): void {
		this.#previousScrollTop = this.deps.getScrollContainer()?.scrollTop ?? this.#previousScrollTop;
		this.#userScrollIntent = {
			epoch: this.#userScrollIntent.epoch + 1,
			direction,
			receivedAt: performance.now(),
		};
		this.#readingAnchor = null;
	}

	prepareInitialBottomRestore(chatId: string | null): void {
		this.#anchorOperationEpoch += 1;
		this.#resetPagingContext();
		this.#initialBottomRestoreChatId = chatId;
	}

	completeInitialBottomRestore(): void {
		if (this.#initialBottomRestoreChatId !== this.deps.sessions.selectedChatId) return;
		if (this.deps.chatState.displayMessageCount === 0) return;
		this.#initialBottomRestoreChatId = null;
	}

	reconcileInitialBottomRestore(autoScrollToBottom: boolean): void {
		if (this.#initialBottomRestoreChatId !== this.deps.sessions.selectedChatId) return;
		if (
			!autoScrollToBottom ||
			this.deps.chatState.loadStatus === 'empty' ||
			this.deps.chatState.loadStatus === 'error'
		) {
			this.#initialBottomRestoreChatId = null;
			return;
		}
		if (!this.deps.chatState.isLoadingMessages && this.deps.chatState.displayMessageCount === 0) {
			this.#initialBottomRestoreChatId = null;
		}
	}

	/** Loads the bounded initial transcript window and scrolls to its first row. */
	async scrollToTop(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId) return;

		this.isScrollingToTop = true;
		try {
			if (!(await this.#navigateToWindow(chatId, 'initial'))) return;
			this.#preserveHistoryBrowsing();
			const node = this.deps.getScrollContainer();
			if (node) {
				this.noteUserScrollIntent('earlier');
				node.scrollTop = 0;
			}
			await this.fillUnderfilledViewport();
		} finally {
			this.isScrollingToTop = false;
		}
	}

	handleScroll(): void {
		const node = this.deps.getScrollContainer();
		if (!node || !this.#isViewportVisible || node.clientHeight <= 0) return;
		const inferredDirection = this.#inferScrollDirection(node.scrollTop);
		this.#applyInferredIntentDirection(inferredDirection);
		if (this.#isPageMutationInProgress) {
			this.#preserveHistoryBrowsing();
			return;
		}
		const nearBottom = this.isNearBottom();
		const hasRecentUserScrollIntent = this.#hasRecentUserScrollIntent();
		if (this.deps.chatState.hasLaterMessages) {
			this.#preserveHistoryBrowsing();
		} else if (hasRecentUserScrollIntent) {
			const hasFreshFollowIntent =
				nearBottom &&
				this.#userScrollIntent.direction === 'later' &&
				this.#userScrollIntent.epoch > this.#followLiveRequiresIntentAfter;
			if (hasFreshFollowIntent) {
				this.deps.chatState.isUserScrolledUp = false;
				this.setPinnedToBottom(true);
				void this.#compactAtLiveEdge(this.deps.sessions.selectedChatId);
			} else if (
				!nearBottom ||
				this.#userScrollIntent.epoch <= this.#followLiveRequiresIntentAfter
			) {
				this.#preserveHistoryBrowsing();
			}
		} else if (!nearBottom && (this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp)) {
			// Resize observers repair pinned layout changes. A layout-generated
			// scroll event must not convert them into history browsing.
			return;
		}

		this.#handleBoundaryProximity('earlier', node.scrollTop < PAGE_BOUNDARY_THRESHOLD_PX);
		this.#handleBoundaryProximity('later', nearBottom);
		if (this.deps.chatState.isUserScrolledUp) this.#captureReadingAnchor();
	}

	async requestPage(
		direction: TranscriptPageDirection,
		reason: PageRequestReason,
	): Promise<TranscriptPageLoadResult> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId || !this.#canRequestPage(direction)) return 'invalidated';

		this.#boundaryArmed[direction] = false;
		this.#followLiveRequiresIntentAfter = Math.max(
			this.#followLiveRequiresIntentAfter,
			this.#userScrollIntent.epoch,
		);
		this.#preserveHistoryBrowsing();

		this.#isPageMutationInProgress = true;
		let result: TranscriptPageLoadResult;
		try {
			result = await this.#mutatePagePreservingViewport(direction, () => {
				if (direction === 'earlier' && this.deps.chatState.revealEarlierLoadedRows()) {
					return 'loaded';
				}
				return direction === 'earlier'
					? this.deps.chatState.loadEarlierPage(chatId)
					: this.deps.chatState.loadLaterPage(chatId);
			});
		} finally {
			const latestIntentEpoch = this.#userScrollIntent.epoch;
			this.#followLiveRequiresIntentAfter = Math.max(
				this.#followLiveRequiresIntentAfter,
				latestIntentEpoch,
			);
			this.#consumedIntentEpoch = {
				earlier: Math.max(this.#consumedIntentEpoch.earlier, latestIntentEpoch),
				later: Math.max(this.#consumedIntentEpoch.later, latestIntentEpoch),
			};
			this.#isPageMutationInProgress = false;
		}
		if (this.deps.sessions.selectedChatId !== chatId) return 'invalidated';
		this.#syncBoundaryLatch(direction);
		if (reason === 'button') this.#captureReadingAnchor();
		return result;
	}

	async loadEarlierPageForNavigator(chatId: string): Promise<TranscriptPageLoadResult> {
		const container = this.deps.getScrollContainer();
		if (!container || this.deps.sessions.selectedChatId !== chatId) return 'invalidated';

		const operationEpoch = ++this.#anchorOperationEpoch;
		const previousHeight = container.scrollHeight;
		const previousTop = container.scrollTop;
		const shouldRemainPinned =
			this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp || this.isNearBottom();

		const result = await this.deps.chatState.loadEarlierPage(chatId);
		if (result !== 'loaded') return result;
		if (!this.#isCurrentAnchorOperation(chatId, operationEpoch)) return 'invalidated';

		await tick();
		if (!this.#isCurrentAnchorOperation(chatId, operationEpoch)) return 'invalidated';

		const updated = this.deps.getScrollContainer();
		if (!updated) return 'invalidated';
		if (shouldRemainPinned) {
			updated.scrollTop = updated.scrollHeight;
			this.deps.chatState.isUserScrolledUp = false;
			this.setPinnedToBottom(true);
		} else {
			updated.scrollTop = previousTop + (updated.scrollHeight - previousHeight);
			this.deps.chatState.isUserScrolledUp = true;
			this.setPinnedToBottom(false);
		}
		return 'loaded';
	}

	#inferScrollDirection(scrollTop: number): TranscriptPageDirection | null {
		const previousTop = this.#previousScrollTop;
		this.#previousScrollTop = scrollTop;
		if (previousTop === null || previousTop === scrollTop) return null;
		return scrollTop < previousTop ? 'earlier' : 'later';
	}

	#applyInferredIntentDirection(direction: TranscriptPageDirection | null): void {
		if (
			!direction ||
			this.#userScrollIntent.direction !== null ||
			!this.#hasRecentUserScrollIntent()
		) {
			return;
		}
		this.#userScrollIntent = { ...this.#userScrollIntent, direction };
	}

	#handleBoundaryProximity(direction: TranscriptPageDirection, isNearBoundary: boolean): void {
		if (!isNearBoundary) {
			this.#boundaryArmed[direction] = true;
			return;
		}
		if (!this.#boundaryArmed[direction] || !this.#canRequestPage(direction)) return;

		const intent = this.#userScrollIntent;
		if (
			intent.epoch <= this.#consumedIntentEpoch[direction] ||
			intent.direction !== direction ||
			!this.#hasRecentUserScrollIntent()
		) {
			return;
		}

		this.#boundaryArmed[direction] = false;
		this.#consumedIntentEpoch[direction] = intent.epoch;
		void this.requestPage(direction, 'scroll');
	}

	#canRequestPage(direction: TranscriptPageDirection): boolean {
		if (
			this.#isPageMutationInProgress ||
			this.deps.chatState.pageStates[direction].status === 'loading'
		)
			return false;
		return direction === 'earlier'
			? this.deps.chatState.canLoadEarlier
			: this.deps.chatState.canLoadLater;
	}

	async #mutatePagePreservingViewport(
		direction: TranscriptPageDirection,
		mutate: () => Promise<TranscriptPageLoadResult> | TranscriptPageLoadResult,
	): Promise<TranscriptPageLoadResult> {
		const chatId = this.deps.sessions.selectedChatId;
		const scroller = this.deps.getScrollContainer();
		if (!chatId || !scroller) return 'invalidated';

		const operationEpoch = ++this.#anchorOperationEpoch;
		const content = this.deps.getScrollContentContainer?.() ?? null;
		const anchor = content ? captureViewportAnchor(scroller, content) : null;
		const previousScrollHeight = scroller.scrollHeight;
		const previousScrollTop = scroller.scrollTop;
		const result = await mutate();
		if (result === 'invalidated' || !this.#isCurrentAnchorOperation(chatId, operationEpoch)) {
			return 'invalidated';
		}

		await tick();
		if (!this.#isCurrentAnchorOperation(chatId, operationEpoch)) return 'invalidated';
		const updatedScroller = this.deps.getScrollContainer();
		const updatedContent = this.deps.getScrollContentContainer?.() ?? null;
		if (!updatedScroller) return 'invalidated';

		const restored =
			anchor && updatedContent
				? restoreViewportAnchor(anchor, updatedScroller, updatedContent)
				: false;
		if (!restored && direction === 'earlier') {
			restoreEarlierHeightFallback(
				{
					rowId: '',
					viewportOffset: 0,
					previousScrollHeight,
					previousScrollTop,
				},
				updatedScroller,
			);
		}
		this.#previousScrollTop = updatedScroller.scrollTop;
		this.#captureReadingAnchor();
		return result;
	}

	#syncBoundaryLatch(direction: TranscriptPageDirection): void {
		if (!this.#isNearBoundary(direction)) this.#boundaryArmed[direction] = true;
	}

	#isNearBoundary(direction: TranscriptPageDirection): boolean {
		const scroller = this.deps.getScrollContainer();
		if (!scroller) return false;
		return direction === 'earlier'
			? scroller.scrollTop < PAGE_BOUNDARY_THRESHOLD_PX
			: this.isNearBottom();
	}

	#captureReadingAnchor(): void {
		const scroller = this.deps.getScrollContainer();
		const content = this.deps.getScrollContentContainer?.();
		this.#readingAnchor = scroller && content ? captureViewportAnchor(scroller, content) : null;
	}

	async jumpToMessageRow(target: UserMessageNavigatorTarget): Promise<boolean> {
		if (
			this.deps.sessions.selectedChatId !== target.chatId ||
			this.deps.chatState.generationId !== target.generationId
		) {
			return false;
		}

		this.#suppressNextVisibleBottomRestore = true;
		this.#restoreBottomOnNextVisible = false;
		this.#cancelBottomRestoreFrame();
		const operationEpoch = ++this.#anchorOperationEpoch;
		await tick();
		if (!this.#isCurrentAnchorOperation(target.chatId, operationEpoch)) {
			this.#suppressNextVisibleBottomRestore = false;
			return false;
		}
		this.deps.chatState.invalidatePendingHistoryLoad();

		const content = this.deps.getScrollContentContainer?.();
		const row = Array.from(content?.querySelectorAll<HTMLElement>('[data-chat-row-id]') ?? []).find(
			(element) => element.dataset.chatRowId === target.rowId,
		);
		if (!row) {
			this.#suppressNextVisibleBottomRestore = false;
			return false;
		}

		const scroller = this.deps.getScrollContainer();
		if (!scroller) {
			this.#suppressNextVisibleBottomRestore = false;
			return false;
		}
		const scrollerRect = scroller.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const rowTop = scroller.scrollTop + rowRect.top - scrollerRect.top;
		scroller.scrollTop = Math.max(0, rowTop - (scroller.clientHeight - rowRect.height) / 2);
		const nearBottom = this.isNearBottom();
		this.deps.chatState.isUserScrolledUp = !nearBottom;
		this.setPinnedToBottom(nearBottom);
		if (!nearBottom) this.#captureReadingAnchor();
		this.#restoreBottomOnNextVisible = false;
		this.#cancelBottomRestoreFrame();
		this.#suppressNextVisibleBottomRestore = false;
		return true;
	}

	#isCurrentAnchorOperation(chatId: string, operationEpoch: number): boolean {
		return (
			this.deps.sessions.selectedChatId === chatId && this.#anchorOperationEpoch === operationEpoch
		);
	}

	async fillUnderfilledViewport(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (this.deps.chatState.hasLaterMessages) {
			this.#preserveHistoryBrowsing();
			await this.#fillUnderfilledInitialWindow(chatId);
			return;
		}
		if (
			!chatId ||
			!this.#isViewportVisible ||
			this.#isAutoFillingViewport ||
			this.deps.chatState.isUserScrolledUp ||
			this.deps.chatState.hasInitialMessagesToReveal
		)
			return;

		this.#isAutoFillingViewport = true;
		try {
			while (this.deps.sessions.selectedChatId === chatId) {
				await tick();
				const container = this.deps.getScrollContainer();
				if (!container) return;
				if (container.scrollHeight > container.clientHeight + 1) return;

				const previousHeight = container.scrollHeight;
				if (!this.deps.chatState.canAutoFillEarlier) return;
				const result = this.deps.chatState.revealEarlierLoadedRows()
					? 'loaded'
					: await this.deps.chatState.loadEarlierPage(chatId);
				if (result !== 'loaded' || this.deps.sessions.selectedChatId !== chatId) return;

				await tick();
				const updated = this.deps.getScrollContainer();
				if (!updated) return;
				this.scrollToBottom();
				if (updated.scrollHeight <= previousHeight) return;
			}
		} finally {
			this.#isAutoFillingViewport = false;
		}
	}

	async #fillUnderfilledInitialWindow(chatId: string | null): Promise<void> {
		if (!chatId || !this.#isViewportVisible || this.#isAutoFillingViewport) return;

		this.#isAutoFillingViewport = true;
		try {
			while (this.deps.sessions.selectedChatId === chatId && this.deps.chatState.hasLaterMessages) {
				await tick();
				const container = this.deps.getScrollContainer();
				if (!container) return;
				if (container.scrollHeight > container.clientHeight + 1) return;

				const previousHeight = container.scrollHeight;
				const result = await this.#mutatePagePreservingViewport('later', () =>
					this.deps.chatState.loadLaterPage(chatId),
				);
				if (result !== 'loaded') return;

				await tick();
				const updated = this.deps.getScrollContainer();
				if (!updated || updated.scrollHeight <= previousHeight) return;
			}
		} finally {
			this.#isAutoFillingViewport = false;
		}
	}

	// Creates a ResizeObserver for the queue controls container that
	// reconciles scroll position when the queue panel height changes.
	// Returns a cleanup function to disconnect the observer.
	observeQueueResize(): (() => void) | undefined {
		const host = this.deps.getQueueContainer();
		const scroller = this.deps.getScrollContainer();
		if (!host || !scroller || typeof ResizeObserver === 'undefined') return undefined;

		let previousHeight = host.offsetHeight;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? host.offsetHeight;
			if (!this.#isViewportVisible || scroller.clientHeight <= 0) {
				previousHeight = nextHeight;
				return;
			}
			const delta = nextHeight - previousHeight;
			const pinned = this.isPinnedToBottom || this.isNearBottom();
			reconcileScrollAfterHeightDelta(delta, pinned, scroller, () => {
				this.#restoreBottomNow();
			});
			previousHeight = nextHeight;
		});
		observer.observe(host);
		return () => observer.disconnect();
	}

	// Keeps pinned conversations at the bottom when the viewport height
	// changes, for example when the mobile keyboard opens or closes.
	observeScrollContainerResize(): (() => void) | undefined {
		const scroller = this.deps.getScrollContainer();
		if (!scroller || typeof ResizeObserver === 'undefined') return undefined;

		let previousHeight = scroller.clientHeight;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? scroller.clientHeight;
			if (nextHeight <= 0 || nextHeight === previousHeight) return;
			const pinned = this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp;
			if (pinned) {
				this.#restoreBottomNow();
			}
			previousHeight = nextHeight;
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}

	// Keeps a durable reading row stable while content settles, or restores
	// the bottom when the conversation is explicitly following live output.
	observeScrollContentResize(): (() => void) | undefined {
		const content = this.deps.getScrollContentContainer?.();
		const scroller = this.deps.getScrollContainer();
		if (!content || !scroller || typeof ResizeObserver === 'undefined') return undefined;

		let previousHeight = content.offsetHeight;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? content.offsetHeight;
			if (nextHeight <= 0 || nextHeight === previousHeight) return;
			previousHeight = nextHeight;
			if (!this.#isViewportVisible || scroller.clientHeight <= 0) return;
			const pinned = this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp;
			if (pinned) {
				this.#restoreBottomNow();
				return;
			}
			if (!this.#readingAnchor) return;
			if (!restoreViewportAnchor(this.#readingAnchor, scroller, content)) {
				this.#captureReadingAnchor();
				return;
			}
			this.#previousScrollTop = scroller.scrollTop;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}

	setViewportVisible(isVisible: boolean): void {
		if (isVisible === this.#isViewportVisible) return;
		this.#isViewportVisible = isVisible;

		if (!isVisible) {
			this.#restoreBottomOnNextVisible = this.#shouldRestoreBottomAfterHidden();
			this.#cancelBottomRestoreFrame();
			return;
		}

		if (!this.#restoreBottomOnNextVisible) return;
		if (this.#suppressNextVisibleBottomRestore) {
			this.#suppressNextVisibleBottomRestore = false;
			this.#restoreBottomOnNextVisible = false;
			this.#cancelBottomRestoreFrame();
			return;
		}
		this.#restoreBottomOnNextVisible = false;
		this.#scheduleBottomRestore();
	}

	#shouldRestoreBottomAfterHidden(): boolean {
		const node = this.deps.getScrollContainer();
		const stateSaysPinned = this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp;
		if (!node || node.clientHeight <= 0) return stateSaysPinned;
		return stateSaysPinned || this.isNearBottom();
	}

	#scheduleBottomRestore(): void {
		this.#cancelBottomRestoreFrame();
		this.#bottomRestoreFrame = requestAnimationFrame(() => {
			this.#bottomRestoreFrame = null;
			this.#restoreBottomNow();
		});
	}

	#restoreBottomNow(): void {
		this.#cancelBottomRestoreFrame();
		if (this.deps.chatState.hasLaterMessages) {
			this.#preserveHistoryBrowsing();
			void this.#fillUnderfilledInitialWindow(this.deps.sessions.selectedChatId);
			return;
		}
		if (!this.#isViewportVisible || this.deps.chatState.isUserScrolledUp) return;
		const node = this.deps.getScrollContainer();
		if (!node || node.clientHeight <= 0) return;
		this.scrollToBottom();
		void this.fillUnderfilledViewport();
	}

	#cancelBottomRestoreFrame(): void {
		if (this.#bottomRestoreFrame === null) return;
		cancelAnimationFrame(this.#bottomRestoreFrame);
		this.#bottomRestoreFrame = null;
	}

	#hasRecentUserScrollIntent(): boolean {
		return (
			this.#userScrollIntent.receivedAt > 0 &&
			performance.now() - this.#userScrollIntent.receivedAt <= USER_SCROLL_INTENT_WINDOW_MS
		);
	}

	async #compactAtLiveEdge(chatId: string | null): Promise<void> {
		if (!chatId || !this.deps.chatState.compactToRecentMessages()) return;
		await tick();
		if (this.deps.sessions.selectedChatId !== chatId || this.deps.chatState.isUserScrolledUp) {
			return;
		}
		this.scrollToBottom();
	}

	async #navigateToWindow(chatId: string, target: TranscriptWindowTarget): Promise<boolean> {
		if (this.deps.sessions.selectedChatId !== chatId) return false;
		const operationEpoch = ++this.#anchorOperationEpoch;
		const result = await this.deps.chatState.navigateToWindow(chatId, target);
		if (result !== 'loaded' || !this.#isCurrentAnchorOperation(chatId, operationEpoch)) {
			return false;
		}
		await tick();
		if (!this.#isCurrentAnchorOperation(chatId, operationEpoch)) return false;
		this.#resetPagingContext();
		return true;
	}

	#resetPagingContext(): void {
		const epoch = this.#userScrollIntent.epoch;
		this.#consumedIntentEpoch = { earlier: epoch, later: epoch };
		this.#boundaryArmed = { earlier: true, later: true };
		this.#followLiveRequiresIntentAfter = epoch;
		this.#readingAnchor = null;
		this.#previousScrollTop = this.deps.getScrollContainer()?.scrollTop ?? null;
	}

	#preserveHistoryBrowsing(): void {
		this.deps.chatState.isUserScrolledUp = true;
		this.setPinnedToBottom(false);
	}

	handleHalfPageScroll(event: KeyboardEvent): void {
		const scrollContainer = this.deps.getScrollContainer();
		if (!scrollContainer) return;

		if (event.ctrlKey && event.key === 'u') {
			const active = document.activeElement;
			const inTextarea = active?.tagName === 'TEXTAREA';
			const inContainer = scrollContainer.contains(active) || active === scrollContainer;
			if (inTextarea || inContainer) {
				event.preventDefault();
				this.noteUserScrollIntent('earlier');
				const half = scrollContainer.clientHeight / 2;
				scrollContainer.scrollBy({
					top: -half,
					behavior: 'instant',
				});
			}
		}
	}
}
