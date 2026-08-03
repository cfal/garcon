import { tick } from 'svelte';
import type {
	ActiveTranscriptState,
	TranscriptPageDirection,
	TranscriptPageLoadResult,
	TranscriptWindowTarget,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import type {
	UserMessageNavigatorSelectionResult,
	UserMessageNavigatorTarget,
} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';

const USER_SCROLL_INTENT_WINDOW_MS = 2_000;
const PAGE_BOUNDARY_THRESHOLD_PX = 100;
const LATER_BOUNDARY_THRESHOLD_PX = 50;

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
	| 'feedMutationClock'
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
	#isAutoFillingViewport = false;
	#isViewportVisible = true;
	#initialBottomRestoreChatId = $state<string | null>(null);
	#userScrollIntent: UserScrollIntent = { epoch: 0, direction: null, receivedAt: 0 };
	#consumedIntentEpoch: Record<TranscriptPageDirection, number> = { earlier: 0, later: 0 };
	#boundaryArmed: Record<TranscriptPageDirection, boolean> = { earlier: true, later: true };
	#followLiveRequiresIntentAfter = 0;
	#previousScrollTop: number | null = null;
	#viewportOperationEpoch = 0;
	#isPageMutationInProgress = false;

	constructor(private deps: ScrollControllerDeps) {}

	isNearBottom(): boolean {
		return this.deps.getViewport()?.isAtEnd(LATER_BOUNDARY_THRESHOLD_PX) ?? false;
	}

	get isPreparingInitialScroll(): boolean {
		return (
			this.#initialBottomRestoreChatId === this.deps.sessions.selectedChatId &&
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
		this.deps.chatState.isUserScrolledUp = !isPinned;
	}

	reconcilePinnedProjection(): void {
		this.deps.chatState.isUserScrolledUp = !this.isPinnedToBottom;
	}

	noteUserScrollIntent(direction: TranscriptPageDirection | null = null): void {
		this.deps.getViewport()?.cancelForUserIntent();
		this.#previousScrollTop = this.deps.getScrollContainer()?.scrollTop ?? this.#previousScrollTop;
		this.#userScrollIntent = {
			epoch: this.#userScrollIntent.epoch + 1,
			direction,
			receivedAt: performance.now(),
		};
	}

	prepareInitialBottomRestore(chatId: string | null): void {
		this.#viewportOperationEpoch += 1;
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
			this.deps.chatState.loadStatus === 'error' ||
			(!this.deps.chatState.isLoadingMessages && this.deps.chatState.displayMessageCount === 0)
		) {
			this.#initialBottomRestoreChatId = null;
			return;
		}
		this.deps.getViewport()?.restoreInitialEnd();
	}

	async scrollToTop(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId) return;

		this.isScrollingToTop = true;
		try {
			if (!(await this.#navigateToWindow(chatId, 'initial'))) return;
			this.#preserveHistoryBrowsing();
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
				this.#userScrollIntent = { ...this.#userScrollIntent, receivedAt: 0 };
				this.deps.getViewport()?.scrollToEnd();
				void this.#compactAtLiveEdge(this.deps.sessions.selectedChatId);
			} else if (
				!nearBottom ||
				this.#userScrollIntent.epoch <= this.#followLiveRequiresIntentAfter
			) {
				this.#preserveHistoryBrowsing();
			}
		} else if (!nearBottom && (this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp)) {
			return;
		}

		this.#handleBoundaryProximity('earlier', node.scrollTop < PAGE_BOUNDARY_THRESHOLD_PX);
		this.#handleBoundaryProximity('later', nearBottom);
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
		if (reason === 'button') this.#preserveHistoryBrowsing();
		return result;
	}

	async loadEarlierPageForNavigator(chatId: string): Promise<TranscriptPageLoadResult> {
		const viewport = this.deps.getViewport();
		if (!viewport || this.deps.sessions.selectedChatId !== chatId) return 'invalidated';
		const operationEpoch = ++this.#viewportOperationEpoch;
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
			this.deps.chatState.generationId !== target.generationId
		) {
			return 'unavailable';
		}
		this.deps.chatState.invalidatePendingHistoryLoad();
		await tick();
		if (
			this.deps.sessions.selectedChatId !== target.chatId ||
			this.deps.chatState.generationId !== target.generationId
		) {
			return 'cancelled';
		}
		const operationEpoch = ++this.#viewportOperationEpoch;
		const viewport = this.deps.getViewport();
		if (!viewport) return 'unavailable';
		const wasPinned = this.isPinnedToBottom;
		this.#preserveHistoryBrowsing();
		const result = await viewport.scrollToTarget(
			{ kind: 'row', id: target.rowId },
			{ align: 'center' },
		);
		if (!this.#isCurrentViewportOperation(target.chatId, operationEpoch)) return 'cancelled';
		if (result === 'cancelled') return 'cancelled';
		if (result !== 'completed') {
			if (wasPinned && viewport.isAtEnd()) this.setPinnedToBottom(true);
			return 'unavailable';
		}
		const atLiveEnd = viewport.isAtEnd();
		this.deps.chatState.isUserScrolledUp = !atLiveEnd;
		this.setPinnedToBottom(atLiveEnd);
		return 'completed';
	}

	async jumpToDomAnchor(anchorId: string): Promise<boolean> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId) return false;
		const operationEpoch = ++this.#viewportOperationEpoch;
		const result = await this.deps
			.getViewport()
			?.scrollToTarget({ kind: 'dom-anchor', id: anchorId }, { align: 'center' });
		return Boolean(
			result === 'completed' && this.#isCurrentViewportOperation(chatId, operationEpoch),
		);
	}

	async fillUnderfilledViewport(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId || !this.#isViewportVisible || this.#isAutoFillingViewport) return;
		if (!this.deps.chatState.hasLaterMessages) {
			if (this.deps.chatState.isUserScrolledUp || this.deps.chatState.hasInitialMessagesToReveal)
				return;
		} else {
			this.#preserveHistoryBrowsing();
		}

		const viewport = this.deps.getViewport();
		if (!viewport) return;
		this.#isAutoFillingViewport = true;
		try {
			while (this.deps.sessions.selectedChatId === chatId && this.#isViewportVisible) {
				const layout = await viewport.waitForLayout({
					minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
				});
				if (layout !== 'settled') return;
				if ((await viewport.measureViewportFill()) !== 'underfilled') return;

				let result: TranscriptPageLoadResult;
				if (this.deps.chatState.hasLaterMessages) {
					result = await this.#mutatePage('later', () => this.deps.chatState.loadLaterPage(chatId));
				} else if (this.deps.chatState.canAutoFillEarlier) {
					result = this.deps.chatState.revealEarlierLoadedRows()
						? await this.#waitForCurrentLayout('loaded')
						: await this.#mutatePage('earlier', () => this.deps.chatState.loadEarlierPage(chatId));
				} else {
					return;
				}
				if (result !== 'loaded') return;
				if (this.isPinnedToBottom && !this.deps.chatState.hasLaterMessages) viewport.scrollToEnd();
			}
		} finally {
			this.#isAutoFillingViewport = false;
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
			if (!this.#isViewportVisible || delta === 0) return;
			const viewport = this.deps.getViewport();
			if (!viewport) return;
			if (this.isPinnedToBottom) viewport.scrollToEnd();
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
			if (this.#isViewportVisible && this.isPinnedToBottom) {
				this.deps.getViewport()?.scrollToEnd();
			}
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}

	setViewportVisible(isVisible: boolean): void {
		if (isVisible === this.#isViewportVisible) return;
		this.#isViewportVisible = isVisible;
		this.#viewportOperationEpoch += 1;
		if (!isVisible) return;
		void this.#restoreVisibleViewport();
	}

	handleHalfPageScroll(event: KeyboardEvent): void {
		const scrollContainer = this.deps.getScrollContainer();
		if (!scrollContainer || !event.ctrlKey || event.key !== 'u') return;
		const active = document.activeElement;
		const inTextarea = active?.tagName === 'TEXTAREA';
		const inContainer = scrollContainer.contains(active) || active === scrollContainer;
		if (!inTextarea && !inContainer) return;
		event.preventDefault();
		this.noteUserScrollIntent('earlier');
		this.deps.getViewport()?.scrollBy(-scrollContainer.clientHeight / 2);
	}

	async #mutatePage(
		direction: TranscriptPageDirection,
		mutate: () => Promise<TranscriptPageLoadResult> | TranscriptPageLoadResult,
	): Promise<TranscriptPageLoadResult> {
		const chatId = this.deps.sessions.selectedChatId;
		const viewport = this.deps.getViewport();
		if (!chatId || !viewport) return 'invalidated';
		const operationEpoch = ++this.#viewportOperationEpoch;
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
		const layout = await viewport.waitForLayout({
			minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
		});
		if (
			layout !== 'settled' ||
			this.deps.chatState.windowRevision !== windowRevision ||
			!this.#isCurrentViewportOperation(chatId, operationEpoch)
		) {
			return 'invalidated';
		}
		return result;
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
		) {
			return false;
		}
		return direction === 'earlier'
			? this.deps.chatState.canLoadEarlier
			: this.deps.chatState.canLoadLater;
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

	#isCurrentViewportOperation(chatId: string, operationEpoch: number): boolean {
		return (
			this.deps.sessions.selectedChatId === chatId &&
			this.#viewportOperationEpoch === operationEpoch
		);
	}

	async #compactAtLiveEdge(chatId: string | null): Promise<void> {
		if (!chatId || !this.deps.chatState.compactToRecentMessages()) return;
		await tick();
		if (this.deps.sessions.selectedChatId !== chatId || this.deps.chatState.isUserScrolledUp)
			return;
		this.scrollToBottom();
	}

	async #navigateToWindow(chatId: string, target: TranscriptWindowTarget): Promise<boolean> {
		if (this.deps.sessions.selectedChatId !== chatId) return false;
		const operationEpoch = ++this.#viewportOperationEpoch;
		const result = await this.deps.chatState.navigateToWindow(chatId, target);
		if (result !== 'loaded' || !this.#isCurrentViewportOperation(chatId, operationEpoch))
			return false;
		const layout = await this.deps.getViewport()?.waitForLayout({
			minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
		});
		if (layout !== 'settled' || !this.#isCurrentViewportOperation(chatId, operationEpoch))
			return false;
		this.#resetPagingContext();
		return true;
	}

	#resetPagingContext(): void {
		const epoch = this.#userScrollIntent.epoch;
		this.#consumedIntentEpoch = { earlier: epoch, later: epoch };
		this.#boundaryArmed = { earlier: true, later: true };
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

	async #restoreVisibleViewport(): Promise<void> {
		await tick();
		if (!this.#isViewportVisible) return;
		const viewport = this.deps.getViewport();
		if (!viewport?.isReady()) return;
		if (this.isPinnedToBottom) {
			viewport.scrollToEnd();
			void this.fillUnderfilledViewport();
			return;
		}
		await viewport.restoreHiddenReadingPosition();
	}
}
