import { tick } from 'svelte';
import type { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type {
	TranscriptPageDirection,
	TranscriptPageLoadResult,
	TranscriptWindowTarget,
} from '$lib/chat/transcript/transcript-page-progress.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import type {
	UserMessageNavigatorSelectionResult,
	UserMessageNavigatorTarget,
} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';

const USER_SCROLL_INTENT_WINDOW_MS = 2_000;
const MIN_PAGE_PREFETCH_DISTANCE_PX = 100;
const EARLIER_PAGE_PREFETCH_VIEWPORTS = 2;
const LIVE_END_REPIN_THRESHOLD_PX = 50;

// Buffers extra earlier history while preserving one-viewport later paging.
function pagePrefetchDistance(direction: TranscriptPageDirection, viewportHeight: number): number {
	const viewportCount = direction === 'earlier' ? EARLIER_PAGE_PREFETCH_VIEWPORTS : 1;
	return Math.max(MIN_PAGE_PREFETCH_DISTANCE_PX, viewportHeight * viewportCount);
}

type PageRequestReason = 'scroll' | 'button';
type WindowNavigationResult = 'settled' | 'committed-unsettled' | 'invalidated';

interface UserScrollIntent {
	epoch: number;
	direction: TranscriptPageDirection | null;
	receivedAt: number;
}

interface DeferredLiveEdgeIntent {
	chatId: string;
	epoch: number;
}

export type ConversationScrollState = Pick<
	ActiveTranscriptState,
	| 'canLoadEarlier'
	| 'displayMessageCount'
	| 'feedMutationClock'
	| 'transcriptViewId'
	| 'hasLaterMessages'
	| 'isLoadingMessages'
	| 'isUserScrolledUp'
	| 'invalidatePendingHistoryLoad'
	| 'invalidatePendingWindowNavigation'
	| 'loadEarlierPage'
	| 'loadLaterPage'
	| 'loadStatus'
	| 'navigateToWindow'
	| 'pageStates'
	| 'revealEarlierLoadedRows'
	| 'windowRevision'
>;

export interface ScrollControllerDeps {
	getScrollContainer: () => HTMLDivElement | null;
	getViewport: () => ConversationViewportPort | null;
	getQueueContainer: () => HTMLDivElement | undefined;
	chatState: ConversationScrollState;
	sessions: { selectedChatId: string | null };
}

export class ConversationScrollController {
	isPinnedToBottom = $state(true);
	isScrollingToTop = $state(false);
	#isAutoFillingViewport = $state(false);
	#refillViewportAfterCurrentFill = false;
	#isViewportVisible = true;
	#initialBottomRestoreChatId = $state<string | null>(null);
	#initialBottomPaintChatId = $state<string | null>(null);
	#userScrollIntent: UserScrollIntent = { epoch: 0, direction: null, receivedAt: 0 };
	#consumedIntentEpoch: Record<TranscriptPageDirection, number> = { earlier: 0, later: 0 };
	#laterBoundaryArmed = true;
	#earlierBoundaryRequestSignature: string | null = null;
	#followLiveRequiresIntentAfter = 0;
	#previousScrollTop: number | null = null;
	#viewportOperationEpoch = 0;
	#deferredLiveEdgeIntent: DeferredLiveEdgeIntent | null = null;
	#isPageMutationInProgress = false;
	#activeTargetNavigations = $state(0);
	#resumeAutoFillAfterTargets = false;
	#lastObservedFeedChatId: string | null;
	#lastObservedTranscriptViewId: string;
	#lastObservedFeedDataRevision: number;

	constructor(private deps: ScrollControllerDeps) {
		this.#lastObservedFeedChatId = deps.sessions.selectedChatId;
		this.#lastObservedTranscriptViewId = deps.chatState.transcriptViewId;
		this.#lastObservedFeedDataRevision = deps.chatState.feedMutationClock.dataRevision;
	}

	isNearBottom(): boolean {
		return this.deps.getViewport()?.isAtEnd(LIVE_END_REPIN_THRESHOLD_PX) ?? false;
	}

	get isPreparingInitialScroll(): boolean {
		return (
			this.#initialBottomPaintChatId === this.deps.sessions.selectedChatId &&
			this.deps.chatState.displayMessageCount > 0 &&
			!this.deps.chatState.isUserScrolledUp
		);
	}

	scrollToBottom(): void {
		const viewport = this.deps.getViewport();
		if (!viewport) return;
		viewport.scrollToEnd();
		this.#previousScrollTop = this.deps.getScrollContainer()?.scrollTop ?? this.#previousScrollTop;
		this.deps.chatState.isUserScrolledUp = false;
		this.setPinnedToBottom(true);
	}

	async scrollToLatest(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId) return;
		if (!this.deps.chatState.hasLaterMessages && !this.isScrollingToTop) {
			this.scrollToBottom();
			return;
		}
		const result = await this.#navigateToWindow(chatId, 'latest', () =>
			this.setPinnedToBottom(true),
		);
		if (result === 'invalidated') return;
		this.scrollToBottom();
	}

	async restoreLatestWindow(chatId: string): Promise<boolean> {
		return (
			(await this.#navigateToWindow(chatId, 'latest', () => this.#preserveHistoryBrowsing())) !==
			'invalidated'
		);
	}

	setPinnedToBottom(isPinned: boolean): void {
		this.isPinnedToBottom = isPinned;
		this.deps.chatState.isUserScrolledUp = !isPinned;
		if (!isPinned) {
			this.#deferredLiveEdgeIntent = null;
		}
	}

	reconcilePinnedProjection(): void {
		const chatId = this.deps.sessions.selectedChatId;
		const transcriptViewId = this.deps.chatState.transcriptViewId;
		const dataRevision = this.deps.chatState.feedMutationClock.dataRevision;
		const feedChanged = chatId !== this.#lastObservedFeedChatId
			|| transcriptViewId !== this.#lastObservedTranscriptViewId
			|| dataRevision !== this.#lastObservedFeedDataRevision;
		this.#lastObservedFeedChatId = chatId;
		this.#lastObservedTranscriptViewId = transcriptViewId;
		this.#lastObservedFeedDataRevision = dataRevision;
		this.deps.chatState.isUserScrolledUp = !this.isPinnedToBottom;
		const deferredIntent = this.#deferredLiveEdgeIntent;
		const viewport = this.deps.getViewport();
		if (
			feedChanged
			&& deferredIntent?.chatId === chatId
			&& deferredIntent.epoch === this.#userScrollIntent.epoch
			&& deferredIntent.epoch > this.#followLiveRequiresIntentAfter
			&& !this.deps.chatState.hasLaterMessages
			&& !viewport?.ownsScrollPosition()
			&& this.isNearBottom()
		) {
			this.#deferredLiveEdgeIntent = null;
			this.setPinnedToBottom(true);
			this.#userScrollIntent = { ...this.#userScrollIntent, receivedAt: 0 };
			viewport?.scrollToEnd();
		}
	}

	noteUserScrollIntent(direction: TranscriptPageDirection | null = null): void {
		this.#deferredLiveEdgeIntent = null;
		this.deps.getViewport()?.cancelForUserIntent(direction);
		// Continued scrolling owns the page's viewport position without cancelling its
		// data request. Explicit navigation still advances the shared operation epoch.
		if (this.#isPageMutationInProgress) {
			this.deps.chatState.invalidatePendingWindowNavigation();
		} else {
			this.#cancelViewportOperations();
		}
		this.#clearInitialBottomRestore();
		this.#previousScrollTop = this.deps.getScrollContainer()?.scrollTop ?? this.#previousScrollTop;
		const intentEpoch = this.#userScrollIntent.epoch + 1;
		this.#userScrollIntent = {
			epoch: intentEpoch,
			direction,
			receivedAt: performance.now(),
		};
		// Evaluates a clamped edge after the gesture because another wheel or key input
		// at that edge may not produce the usual scroll event.
		if (direction) {
			const chatId = this.deps.sessions.selectedChatId;
			queueMicrotask(() => {
				if (
					this.#userScrollIntent.epoch !== intentEpoch ||
					this.#userScrollIntent.direction !== direction ||
					this.deps.sessions.selectedChatId !== chatId
				) {
					return;
				}
				this.#handleBoundaryProximity(direction, this.#isNearPageBoundary(direction));
			});
		}
	}

	prepareInitialBottomRestore(chatId: string | null): void {
		// The next chat's paint gate must not be completed by a deferred end restore
		// that still belongs to the prior virtual surface.
		this.deps.getViewport()?.cancelPendingLayoutMutation();
		this.#cancelViewportOperations();
		this.#resetPagingContext();
		this.#initialBottomRestoreChatId = chatId;
		this.#initialBottomPaintChatId = chatId;
	}

	completeInitialBottomRestore(): void {
		if (this.#initialBottomRestoreChatId !== this.deps.sessions.selectedChatId) return;
		if (this.deps.chatState.displayMessageCount === 0) return;
		this.#initialBottomPaintChatId = null;
		this.#initialBottomRestoreChatId = null;
	}

	reconcileInitialBottomRestore(autoScrollToBottom: boolean): void {
		if (this.#initialBottomRestoreChatId !== this.deps.sessions.selectedChatId) return;
		if (this.#isAutoFillingViewport || this.#activeTargetNavigations > 0) return;
		if (
			!autoScrollToBottom ||
			this.deps.chatState.loadStatus === 'empty' ||
			this.deps.chatState.loadStatus === 'error' ||
			(!this.deps.chatState.isLoadingMessages && this.deps.chatState.displayMessageCount === 0)
		) {
			this.#clearInitialBottomRestore();
			return;
		}
		this.deps.getViewport()?.restoreInitialEnd();
	}

	#clearInitialBottomRestore(): void {
		this.#initialBottomRestoreChatId = null;
		this.#initialBottomPaintChatId = null;
	}

	async scrollToTop(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId) return;

		this.isScrollingToTop = true;
		try {
			const result = await this.#navigateToWindow(chatId, 'initial', () =>
				this.#preserveHistoryBrowsing(),
			);
			if (result === 'invalidated') return;
			this.noteUserScrollIntent('earlier');
			this.deps.getViewport()?.scrollToStart();
			await this.fillUnderfilledViewport();
		} finally {
			this.isScrollingToTop = false;
		}
	}

	handleScroll(): void {
		const node = this.deps.getScrollContainer();
		if (!node || !this.#isViewportVisible || node.clientHeight <= 0) return;
		const inferredDirection = this.#inferScrollDirection(node.scrollTop);
		if (this.#isPageMutationInProgress) {
			const shouldReaffirmUserOwnership =
				inferredDirection !== null &&
				this.#userScrollIntent.direction === inferredDirection &&
				this.#hasRecentUserScrollIntent();
			this.#applyInferredIntentDirection(inferredDirection);
			if (shouldReaffirmUserOwnership) {
				this.deps.getViewport()?.cancelForUserIntent(inferredDirection);
			}
			this.#preserveHistoryBrowsing();
			return;
		}
		if (this.deps.getViewport()?.ownsScrollPosition()) {
			const chatId = this.deps.sessions.selectedChatId;
			if (
				chatId
				&& !this.deps.chatState.hasLaterMessages
				&& this.#userScrollIntent.direction === 'later'
				&& this.#userScrollIntent.epoch > this.#followLiveRequiresIntentAfter
				&& this.#hasRecentUserScrollIntent()
				&& this.isNearBottom()
			) {
				this.#deferredLiveEdgeIntent = {
					chatId,
					epoch: this.#userScrollIntent.epoch,
				};
			}
			return;
		}
		this.#deferredLiveEdgeIntent = null;
		this.#reconcileUserScroll(inferredDirection);
	}

	#reconcileUserScroll(inferredDirection: TranscriptPageDirection | null): void {
		this.#applyInferredIntentDirection(inferredDirection);
		const nearBottom = this.isNearBottom();
		const hasRecentUserScrollIntent = this.#hasRecentUserScrollIntent();
		if (this.deps.chatState.hasLaterMessages) {
			this.#preserveHistoryBrowsing();
		} else if (
			hasRecentUserScrollIntent &&
			this.#userScrollIntent.epoch > this.#followLiveRequiresIntentAfter
		) {
			const hasFreshFollowIntent = nearBottom && this.#userScrollIntent.direction === 'later';
			if (hasFreshFollowIntent) {
				this.deps.chatState.isUserScrolledUp = false;
				this.setPinnedToBottom(true);
				this.#userScrollIntent = { ...this.#userScrollIntent, receivedAt: 0 };
				this.deps.getViewport()?.scrollToEnd();
			} else if (!nearBottom || this.#userScrollIntent.direction === 'earlier') {
				this.#preserveHistoryBrowsing();
			}
		} else if (!nearBottom && (this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp)) {
			return;
		}

		this.#handleBoundaryProximity('earlier', this.#isNearPageBoundary('earlier'));
		this.#handleBoundaryProximity('later', this.#isNearPageBoundary('later'));
	}

	async requestPage(
		direction: TranscriptPageDirection,
		reason: PageRequestReason,
	): Promise<TranscriptPageLoadResult> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId || !this.#canRequestPage(direction, reason === 'button')) return 'invalidated';
		const requestIntentEpoch = this.#userScrollIntent.epoch;
		const requestBoundarySignature =
			direction === 'earlier' ? this.#earlierBoundarySignature() : null;

		// Records the crossed boundary before awaiting data. Earlier history advances
		// its signature, while later paging re-arms only after leaving or continuing.
		if (direction === 'later') this.#laterBoundaryArmed = false;
		if (requestBoundarySignature) {
			this.#earlierBoundaryRequestSignature = requestBoundarySignature;
		}
		// Requires a fresh post-page downward gesture before near-end geometry resumes live following.
		this.#followLiveRequiresIntentAfter = Math.max(
			this.#followLiveRequiresIntentAfter,
			this.#userScrollIntent.epoch,
		);
		this.#preserveHistoryBrowsing();
		this.#isPageMutationInProgress = true;
		let result: TranscriptPageLoadResult;
		let continuedPageIntent: boolean;
		try {
			result = await this.#mutatePage(direction, () => {
				if (direction === 'earlier' && this.deps.chatState.revealEarlierLoadedRows()) {
					return 'loaded';
				}
				return direction === 'earlier'
					? this.deps.chatState.loadEarlierPage(chatId)
					: this.deps.chatState.loadLaterPage(chatId);
			});
		} finally {
			const latestIntentEpoch = this.#userScrollIntent.epoch;
			continuedPageIntent =
				reason === 'scroll' && this.#hasContinuedPageIntent(direction, requestIntentEpoch);
			// Layout-generated scroll events cannot chain pages because they add no input
			// epoch. A newer same-direction gesture remains eligible after layout settles.
			this.#followLiveRequiresIntentAfter = Math.max(
				this.#followLiveRequiresIntentAfter,
				latestIntentEpoch,
			);
			this.#consumedIntentEpoch = {
				earlier: Math.max(
					this.#consumedIntentEpoch.earlier,
					direction === 'earlier' && continuedPageIntent ? requestIntentEpoch : latestIntentEpoch,
				),
				later: Math.max(
					this.#consumedIntentEpoch.later,
					direction === 'later' && continuedPageIntent ? requestIntentEpoch : latestIntentEpoch,
				),
			};
			this.#isPageMutationInProgress = false;
		}
		if (this.deps.sessions.selectedChatId !== chatId) return 'invalidated';
		if (
			direction === 'earlier' &&
			result === 'invalidated' &&
			this.#earlierBoundaryRequestSignature === requestBoundarySignature
		) {
			this.#earlierBoundaryRequestSignature = null;
		}
		this.#syncBoundaryLatch(direction);
		if (reason === 'button') this.#preserveHistoryBrowsing();
		if (continuedPageIntent && this.#isNearPageBoundary(direction) && result === 'loaded') {
			if (direction === 'later') this.#laterBoundaryArmed = true;
			this.#handleBoundaryProximity(direction, true);
		}
		return result;
	}

	async loadEarlierPageForNavigator(chatId: string): Promise<TranscriptPageLoadResult> {
		const viewport = this.deps.getViewport();
		if (!viewport || this.deps.sessions.selectedChatId !== chatId) return 'invalidated';
		const operationEpoch = this.#beginViewportOperation();
		const shouldRemainPinned = this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp;
		const result = await this.deps.chatState.loadEarlierPage(chatId);
		if (result !== 'loaded' || !this.#isCurrentViewportOperation(chatId, operationEpoch)) {
			return result === 'loaded' ? 'invalidated' : result;
		}
		const layout = await viewport.waitForLayout({
			minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
		});
		if (layout !== 'settled' || !this.#isCurrentViewportOperation(chatId, operationEpoch)) {
			return 'invalidated';
		}
		if (shouldRemainPinned) {
			viewport.scrollToEnd();
			this.deps.chatState.isUserScrolledUp = false;
			this.setPinnedToBottom(true);
		} else {
			this.#preserveHistoryBrowsing();
		}
		return 'loaded';
	}

	async jumpToMessageRow(
		target: UserMessageNavigatorTarget,
	): Promise<UserMessageNavigatorSelectionResult> {
		if (
			this.deps.sessions.selectedChatId !== target.chatId ||
			this.deps.chatState.transcriptViewId !== target.transcriptViewId
		) {
			return 'unavailable';
		}
		const wasPinned = this.isPinnedToBottom;
		let shouldResumeAutoFill = false;
		this.#activeTargetNavigations += 1;
		try {
			this.deps.chatState.invalidatePendingHistoryLoad();
			await tick();
			if (
				this.deps.sessions.selectedChatId !== target.chatId ||
				this.deps.chatState.transcriptViewId !== target.transcriptViewId
			) {
				return 'cancelled';
			}
			const operationEpoch = this.#beginViewportOperation();
			const viewport = this.deps.getViewport();
			if (!viewport) return 'unavailable';
			this.#preserveHistoryBrowsing();
			const result = await viewport.scrollToTarget(
				{ kind: 'row', id: target.rowId },
				{ align: 'center' },
			);
			if (!this.#isCurrentViewportOperation(target.chatId, operationEpoch)) return 'cancelled';
			if (result === 'cancelled') return 'cancelled';
			if (result !== 'completed') {
				if (wasPinned) {
					viewport.scrollToEnd();
					this.setPinnedToBottom(true);
				}
				return 'unavailable';
			}
			const atLiveEnd = viewport.isAtEnd();
			this.setPinnedToBottom(atLiveEnd);
			shouldResumeAutoFill = true;
			return 'completed';
		} finally {
			this.#finishTargetNavigation(shouldResumeAutoFill);
		}
	}

	async jumpToDomAnchor(anchorId: string): Promise<boolean> {
		const chatId = this.deps.sessions.selectedChatId;
		const viewport = this.deps.getViewport();
		if (!chatId || !viewport) return false;
		let shouldResumeAutoFill = false;
		this.#activeTargetNavigations += 1;
		try {
			const operationEpoch = this.#beginViewportOperation();
			const result = await viewport.scrollToTarget(
				{ kind: 'dom-anchor', id: anchorId },
				{ align: 'center' },
			);
			const completed = Boolean(
				result === 'completed' && this.#isCurrentViewportOperation(chatId, operationEpoch),
			);
			if (completed) this.setPinnedToBottom(viewport.isAtEnd());
			shouldResumeAutoFill = completed;
			return completed;
		} finally {
			this.#finishTargetNavigation(shouldResumeAutoFill);
		}
	}

	async fillUnderfilledViewport(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (
			!chatId ||
			!this.#isViewportVisible ||
			this.#isAutoFillingViewport ||
			this.#activeTargetNavigations > 0
		) {
			return;
		}
		if (!this.deps.chatState.hasLaterMessages) {
			if (this.deps.chatState.isUserScrolledUp) return;
		} else {
			this.#preserveHistoryBrowsing();
		}

		const viewport = this.deps.getViewport();
		if (!viewport) return;
		this.#isAutoFillingViewport = true;
		try {
			// Deliberately chains pages only while the visible viewport remains underfilled.
			// This is the sole geometry-driven paging path.
			while (this.deps.sessions.selectedChatId === chatId && this.#isViewportVisible) {
				if (this.#activeTargetNavigations > 0) return;
				const layout = await viewport.waitForLayout({
					minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
				});
				if (layout !== 'settled') return;
				if ((await viewport.measureViewportFill()) !== 'underfilled') return;
				if (this.#activeTargetNavigations > 0) return;

				let result: TranscriptPageLoadResult;
				if (this.deps.chatState.hasLaterMessages) {
					if (!this.#canRequestPage('later')) return;
					result = await this.#mutatePage('later', () => this.deps.chatState.loadLaterPage(chatId));
				} else if (this.deps.chatState.canLoadEarlier) {
					if (!this.#canRequestPage('earlier')) return;
					if (this.deps.chatState.revealEarlierLoadedRows()) {
						result = await this.#waitForCurrentLayout('loaded');
					} else {
						result = await this.#mutatePage('earlier', () =>
							this.deps.chatState.loadEarlierPage(chatId),
						);
					}
				} else {
					return;
				}
				if (result !== 'loaded') return;
				if (this.isPinnedToBottom && !this.deps.chatState.hasLaterMessages) viewport.scrollToEnd();
			}
		} finally {
			this.#isAutoFillingViewport = false;
			if (this.#refillViewportAfterCurrentFill) {
				this.#refillViewportAfterCurrentFill = false;
				void this.fillUnderfilledViewport();
			}
		}
	}

	observeQueueResize(): (() => void) | undefined {
		const host = this.deps.getQueueContainer();
		if (!host || typeof ResizeObserver === 'undefined') return undefined;
		let previousHeight = host.offsetHeight;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? host.offsetHeight;
			const delta = nextHeight - previousHeight;
			previousHeight = nextHeight;
			if (!this.#isViewportVisible || this.#activeTargetNavigations > 0 || delta === 0) return;
			const viewport = this.deps.getViewport();
			if (!viewport) return;
			if (this.isPinnedToBottom) this.scrollToBottom();
			else viewport.scrollBy(delta);
		});
		observer.observe(host);
		return () => observer.disconnect();
	}

	observeScrollContainerResize(): (() => void) | undefined {
		const scroller = this.deps.getScrollContainer();
		if (!scroller || typeof ResizeObserver === 'undefined') return undefined;
		let previousHeight = scroller.clientHeight;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? scroller.clientHeight;
			if (nextHeight <= 0 || nextHeight === previousHeight) return;
			previousHeight = nextHeight;
			if (this.#isViewportVisible && this.#activeTargetNavigations === 0 && this.isPinnedToBottom) {
				this.scrollToBottom();
			}
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}

	setViewportVisible(isVisible: boolean): void {
		if (isVisible === this.#isViewportVisible) return;
		this.#isViewportVisible = isVisible;
		this.#cancelViewportOperations();
		this.#previousScrollTop = this.deps.getScrollContainer()?.scrollTop ?? null;
		if (!isVisible) return;
		void this.#restoreVisibleViewport();
	}

	// Scrolls the feed through its virtual viewport and reconciles pinning state.
	scrollFeedHalfPage(direction: TranscriptPageDirection): void {
		const scrollContainer = this.deps.getScrollContainer();
		if (!scrollContainer) return;
		this.noteUserScrollIntent(direction);
		const half = scrollContainer.clientHeight / 2;
		const viewport = this.deps.getViewport();
		viewport?.scrollBy(direction === 'later' ? half : -half);
		if (viewport) this.#reconcileUserScroll(direction);
	}

	async #mutatePage(
		direction: TranscriptPageDirection,
		mutate: () => Promise<TranscriptPageLoadResult> | TranscriptPageLoadResult,
	): Promise<TranscriptPageLoadResult> {
		const chatId = this.deps.sessions.selectedChatId;
		const viewport = this.deps.getViewport();
		if (!chatId || !viewport) return 'invalidated';
		const operationEpoch = this.#beginViewportOperation();
		const userIntentEpoch = this.#userScrollIntent.epoch;
		const windowRevision = this.deps.chatState.windowRevision;
		const result = await mutate();
		if (
			result === 'invalidated' ||
			this.deps.chatState.windowRevision !== windowRevision ||
			!this.#isCurrentViewportOperation(chatId, operationEpoch)
		) {
			return 'invalidated';
		}
		if (result !== 'loaded') return result;
		// Waits until the data revision and anchor correction settle. A continued paging
		// gesture already owns the viewport, so it may proceed after superseding that correction.
		const layout = await viewport.waitForLayout({
			minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
		});
		if (
			this.deps.chatState.windowRevision !== windowRevision ||
			!this.#isCurrentViewportOperation(chatId, operationEpoch)
		) {
			return 'invalidated';
		}
		return layout === 'settled' || this.#hasContinuedPageIntent(direction, userIntentEpoch)
			? result
			: 'invalidated';
	}

	async #waitForCurrentLayout(result: TranscriptPageLoadResult): Promise<TranscriptPageLoadResult> {
		const layout = await this.deps.getViewport()?.waitForLayout({
			minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
		});
		return layout === 'settled' ? result : 'invalidated';
	}

	#inferScrollDirection(scrollTop: number): TranscriptPageDirection | null {
		const previousTop = this.#previousScrollTop;
		this.#previousScrollTop = scrollTop;
		if (previousTop === null || previousTop === scrollTop) return null;
		return scrollTop < previousTop ? 'earlier' : 'later';
	}

	#applyInferredIntentDirection(direction: TranscriptPageDirection | null): void {
		if (!direction || !this.#hasRecentUserScrollIntent()) return;
		if (this.#userScrollIntent.direction === null) {
			this.deps.getViewport()?.cancelForUserIntent(direction);
			this.#userScrollIntent = { ...this.#userScrollIntent, direction };
		}
		if (this.#userScrollIntent.direction === direction) {
			this.#userScrollIntent = { ...this.#userScrollIntent, receivedAt: performance.now() };
		}
	}

	#handleBoundaryProximity(direction: TranscriptPageDirection, isNearBoundary: boolean): void {
		if (!isNearBoundary) {
			if (direction === 'earlier') this.#earlierBoundaryRequestSignature = null;
			else this.#laterBoundaryArmed = true;
			return;
		}
		if (!this.#canRequestPage(direction)) return;
		if (direction === 'earlier') {
			if (this.#earlierBoundaryRequestSignature === this.#earlierBoundarySignature()) return;
		} else if (!this.#laterBoundaryArmed) {
			return;
		}
		const intent = this.#userScrollIntent;
		const hasEligibleIntent =
			intent.epoch > this.#consumedIntentEpoch[direction] &&
			intent.direction === direction &&
			this.#hasRecentUserScrollIntent();
		if (!hasEligibleIntent) {
			return;
		}
		if (direction === 'later') this.#laterBoundaryArmed = false;
		this.#consumedIntentEpoch[direction] = intent.epoch;
		void this.requestPage(direction, 'scroll');
	}

	#canRequestPage(direction: TranscriptPageDirection, allowRetry = false): boolean {
		if (
			this.#activeTargetNavigations > 0 ||
			this.#isPageMutationInProgress ||
			this.deps.chatState.pageStates[direction].status === 'loading' ||
			(!allowRetry && this.deps.chatState.pageStates[direction].status === 'error')
		) {
			return false;
		}
		return direction === 'earlier'
			? this.deps.chatState.canLoadEarlier
			: this.deps.chatState.hasLaterMessages;
	}

	#syncBoundaryLatch(direction: TranscriptPageDirection): void {
		if (this.#isNearPageBoundary(direction)) return;
		if (direction === 'earlier') this.#earlierBoundaryRequestSignature = null;
		else this.#laterBoundaryArmed = true;
	}

	#isNearPageBoundary(direction: TranscriptPageDirection): boolean {
		const scroller = this.deps.getScrollContainer();
		if (!scroller || scroller.clientHeight <= 0) return false;
		const distance = pagePrefetchDistance(direction, scroller.clientHeight);
		return direction === 'earlier'
			? scroller.scrollTop <= distance
			: (this.deps.getViewport()?.isAtEnd(distance) ?? false);
	}

	#earlierBoundarySignature(): string {
		return [
			this.deps.sessions.selectedChatId ?? '',
			this.deps.chatState.transcriptViewId,
			this.deps.chatState.windowRevision,
			this.deps.chatState.feedMutationClock.lastRevisionByKind['history-earlier'],
		].join(':');
	}

	#isCurrentViewportOperation(chatId: string, operationEpoch: number): boolean {
		return (
			this.deps.sessions.selectedChatId === chatId &&
			this.#viewportOperationEpoch === operationEpoch
		);
	}

	#beginViewportOperation(): number {
		this.#deferredLiveEdgeIntent = null;
		this.deps.chatState.invalidatePendingWindowNavigation();
		return ++this.#viewportOperationEpoch;
	}

	#cancelViewportOperations(): void {
		this.#deferredLiveEdgeIntent = null;
		this.deps.chatState.invalidatePendingWindowNavigation();
		this.#viewportOperationEpoch += 1;
	}

	#finishTargetNavigation(shouldResumeAutoFill: boolean): void {
		this.#resumeAutoFillAfterTargets ||= shouldResumeAutoFill;
		this.#activeTargetNavigations -= 1;
		if (this.#activeTargetNavigations > 0 || !this.#resumeAutoFillAfterTargets) return;
		this.#resumeAutoFillAfterTargets = false;
		if (this.#isAutoFillingViewport) {
			this.#refillViewportAfterCurrentFill = true;
		} else {
			void this.fillUnderfilledViewport();
		}
	}

	async #navigateToWindow(
		chatId: string,
		target: TranscriptWindowTarget,
		onCommitted: () => void,
	): Promise<WindowNavigationResult> {
		if (this.deps.sessions.selectedChatId !== chatId) return 'invalidated';
		const operationEpoch = this.#beginViewportOperation();
		const result = await this.deps.chatState.navigateToWindow(chatId, target);
		if (result !== 'loaded' || !this.#isCurrentViewportOperation(chatId, operationEpoch)) {
			return 'invalidated';
		}
		onCommitted();
		this.#resetPagingContext();
		const layout = await this.deps.getViewport()?.waitForLayout({
			minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
		});
		if (!this.#isCurrentViewportOperation(chatId, operationEpoch)) return 'invalidated';
		return layout === 'settled' ? 'settled' : 'committed-unsettled';
	}

	#resetPagingContext(): void {
		const epoch = this.#userScrollIntent.epoch;
		this.#consumedIntentEpoch = { earlier: epoch, later: epoch };
		this.#laterBoundaryArmed = true;
		this.#earlierBoundaryRequestSignature = null;
		this.#followLiveRequiresIntentAfter = epoch;
		this.#previousScrollTop = this.deps.getScrollContainer()?.scrollTop ?? null;
	}

	#preserveHistoryBrowsing(): void {
		this.deps.chatState.isUserScrolledUp = true;
		this.setPinnedToBottom(false);
	}

	#hasRecentUserScrollIntent(): boolean {
		return (
			this.#userScrollIntent.receivedAt > 0 &&
			performance.now() - this.#userScrollIntent.receivedAt <= USER_SCROLL_INTENT_WINDOW_MS
		);
	}

	#hasContinuedPageIntent(direction: TranscriptPageDirection, requestIntentEpoch: number): boolean {
		return (
			this.#userScrollIntent.epoch > requestIntentEpoch &&
			this.#userScrollIntent.direction === direction &&
			this.#hasRecentUserScrollIntent()
		);
	}

	async #restoreVisibleViewport(): Promise<void> {
		const operationEpoch = this.#viewportOperationEpoch;
		await tick();
		if (
			!this.#isViewportVisible ||
			operationEpoch !== this.#viewportOperationEpoch ||
			this.#activeTargetNavigations > 0
		) {
			return;
		}
		const viewport = this.deps.getViewport();
		if (!viewport?.isReady()) return;
		if (this.isPinnedToBottom) {
			viewport.scrollToEnd();
			void this.#reverifyEndAfterShow(operationEpoch);
			return;
		}
		await viewport.restoreHiddenReadingPosition();
	}

	// Show-time measurements and deferred scale invalidation can land after the end
	// convergence loop was superseded by a concurrent publication, leaving a pinned
	// viewport short of the physical end; bounded layout waits and rechecks restore it.
	async #reverifyEndAfterShow(operationEpoch: number): Promise<void> {
		await this.fillUnderfilledViewport();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await this.deps.getViewport()?.waitForLayout();
			if (
				!this.#isViewportVisible ||
				operationEpoch !== this.#viewportOperationEpoch ||
				this.#activeTargetNavigations > 0 ||
				!this.isPinnedToBottom
			) {
				return;
			}
			const viewport = this.deps.getViewport();
			if (!viewport?.isReady()) return;
			if (viewport.isAtEnd()) return;
			viewport.scrollToEnd();
		}
	}
}
