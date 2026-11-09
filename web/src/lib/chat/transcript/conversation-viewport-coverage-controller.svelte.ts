import type { ConversationScrollControllerDeps } from './conversation-scroll-controller-contract.js';
import type { ConversationViewportPort } from './conversation-viewport-port.js';
import type { TranscriptPageApplicationGate, TranscriptPageDirection, TranscriptPageLoadResult } from './transcript-page-progress.js';
import type { ConversationNativeScrollSettlement } from './conversation-native-scroll-settlement.js';
import { fillConversationViewport } from './conversation-viewport-auto-fill.js';
import { observeConversationQueueResize } from './conversation-queue-resize.js';

export const USER_SCROLL_INTENT_WINDOW_MS = 2_000;
export type PageApplicationPolicy = 'immediate' | 'after-native-scroll';
type PageMutation = (gate: TranscriptPageApplicationGate | undefined) => Promise<TranscriptPageLoadResult> | TranscriptPageLoadResult;

interface ConversationViewportCoverageOwner {
	isVisible(): boolean;
	isPinnedToBottom(): boolean;
	hasTargetNavigation(): boolean;
	hasInitialRestore(): boolean;
	intentEpoch(): number;
	intentReceivedAt(): number;
	hasRecentIntent(): boolean;
	hasManualPage(): boolean;
	preserveHistoryBrowsing(): void;
	scrollToBottom(): void;
	canRequestPage(direction: TranscriptPageDirection): boolean;
	mutatePage(direction: TranscriptPageDirection, mutation: PageMutation, policy: PageApplicationPolicy): Promise<TranscriptPageLoadResult>;
	isCurrentViewportOperation(chatId: string, epoch: number): boolean;
}

export class ConversationViewportCoverageController {
	isFilling = $state(false);
	isMeasuring = $state(false);
	#refillViewportAfterCurrentFill = false;
	#coveragePending = false;
	#coverageWakeRevision = 0;
	#coverageServicedRevision = 0;
	#coveragePromise: Promise<void> | null = null;
	#coverageScheduled = false;
	#measurementWakeCleanup: (() => void) | null = null;
	#intentWakeTimer: ReturnType<typeof setTimeout> | null = null;
	#pendingPinnedEnd: { viewport: ConversationViewportPort; windowRevision: number; intentEpoch: number } | null = null;
	#disposed = false;

	constructor(
		private readonly deps: ConversationScrollControllerDeps,
		private readonly owner: ConversationViewportCoverageOwner,
		private readonly nativeScroll: ConversationNativeScrollSettlement,
	) {}

	destroy(): void {
		this.#disposed = true;
		this.#refillViewportAfterCurrentFill = false;
		this.#coveragePending = false;
		this.#pendingPinnedEnd = null;
		this.#measurementWakeCleanup?.();
		this.#measurementWakeCleanup = null;
		if (this.#intentWakeTimer !== null) clearTimeout(this.#intentWakeTimer);
		this.#intentWakeTimer = null;
	}

	resumeAfterNavigation(): void {
		if (this.isFilling) this.#refillViewportAfterCurrentFill = true;
		else void this.fillUnderfilledViewport();
	}

	async fillUnderfilledViewport(): Promise<void> {
		if (this.#disposed) return;
		if (this.deps.chatState.combinedMode) {
			this.#coveragePending = true;
			this.#coverageWakeRevision += 1;
			return this.#resumeCoverage();
		}
		const chatId = this.deps.getChatId();
		if (
			!chatId ||
			!this.owner.isVisible() ||
			this.owner.hasTargetNavigation()
		) {
			return;
		}
		if (this.isFilling) return;
		if (!this.deps.chatState.hasLaterMessages) {
			if (this.deps.chatState.isUserScrolledUp) return;
		} else {
			this.owner.preserveHistoryBrowsing();
		}

		const viewport = this.deps.getViewport();
		if (!viewport) return;
		const transcriptViewId = this.deps.chatState.transcriptViewId;
		const intentEpoch = this.owner.intentEpoch();
		const ownsFill = () =>
			this.deps.getChatId() === chatId &&
			this.deps.chatState.transcriptViewId === transcriptViewId &&
			this.owner.isVisible() &&
			this.owner.intentEpoch() === intentEpoch &&
			!this.owner.hasTargetNavigation();
		this.isFilling = true;
		try {
			await fillConversationViewport({
				chatId,
				viewport,
				chatState: this.deps.chatState,
				isCurrent: ownsFill,
				canRequestPage: (direction) => this.owner.canRequestPage(direction),
				mutatePage: (direction, load) => this.owner.mutatePage(direction, load, 'immediate'),
				waitForCurrentLayout: () => this.#waitForCurrentLayout(),
				isPinnedToBottom: () => this.owner.isPinnedToBottom(),
			});
		} finally {
			this.isFilling = false;
			if (this.#refillViewportAfterCurrentFill) {
				this.#refillViewportAfterCurrentFill = false;
				void this.fillUnderfilledViewport();
			}
		}
	}

	wakeCoverage(): void {
		if (this.#disposed || !this.deps.chatState.combinedMode) return;
		this.#coveragePending = true;
		this.#coverageWakeRevision += 1;
		if (this.#coveragePromise || this.#coverageScheduled) return;
		this.#coverageScheduled = true;
		queueMicrotask(() => {
			this.#coverageScheduled = false;
			void this.#resumeCoverage();
		});
	}

	#coverageAvailable(): boolean {
		return !this.#disposed && this.deps.chatState.combinedMode && this.owner.isVisible()
			&& !this.owner.hasTargetNavigation() && !this.owner.hasInitialRestore()
			&& !this.deps.chatState.isLoadingMessages;
	}

	#resumeCoverage(): Promise<void> {
		if (this.#coveragePromise) return this.#coveragePromise;
		if (!this.#coveragePending || !this.#coverageAvailable() || !this.deps.getChatId()) return Promise.resolve();
		const run = this.#runCoverage();
		this.#coveragePromise = run;
		return run.finally(() => {
			if (this.#coveragePromise !== run) return;
			this.#coveragePromise = null;
			if (this.#coverageWakeRevision !== this.#coverageServicedRevision && this.#coverageAvailable()) this.wakeCoverage();
		});
	}

	async #runCoverage(): Promise<void> {
		const chatId = this.deps.getChatId();
		const viewId = this.deps.chatState.transcriptViewId;
		const current = () => this.#coverageAvailable() && this.deps.getChatId() === chatId
			&& this.deps.chatState.transcriptViewId === viewId;
		while (chatId && current() && this.#coveragePending) {
			this.#coverageServicedRevision = this.#coverageWakeRevision;
			if (this.owner.hasRecentIntent() || this.nativeScroll.activity !== 'idle') {
				this.armIntentWake();
				return;
			}
			const viewport = this.deps.getViewport();
			if (!viewport) return;
			const pinnedTarget = this.#isPinnedAtLiveEnd()
				&& this.deps.chatState.hasPendingAnchorDemand('earlier');
			this.armMeasurementWake(viewport);
			if (!viewport.isReady()) return;
			this.#restorePendingPinnedEnd(viewport);
			const fill = pinnedTarget ? 'overflow' : await this.#measureCoverage(viewport);
			if (!current()) return;
			if (fill === 'superseded') {
				await this.#yieldLayout();
				continue;
			}
			if (fill === 'unsettled') return;
			this.#measurementWakeCleanup?.();
			this.#measurementWakeCleanup = null;
			if (fill === 'overflow' && !pinnedTarget) {
				this.#coveragePending = false;
				return;
			}
			const direction = this.deps.chatState.hasLaterMessages ? 'later' : 'earlier';
			if (this.deps.chatState.isPageLoading(direction)) {
				await (direction === 'earlier' ? this.deps.chatState.loadEarlierPage(chatId) : this.deps.chatState.loadLaterPage(chatId));
				continue;
			}
			if (!this.owner.canRequestPage(direction)) return;
			const before = this.#rawFrontier();
			const result = await this.owner.mutatePage(direction, applicationGate => {
				const options = { applicationGate, shouldContinue: () => this.#allowCoverageChunk(direction) };
				return direction === 'earlier'
					? this.deps.chatState.loadEarlierPage(chatId, options)
					: this.deps.chatState.loadLaterPage(chatId, options);
			}, 'after-native-scroll');
			if (!current()) return;
			if (this.owner.hasRecentIntent() || this.nativeScroll.activity !== 'idle') {
				if (result === 'loaded' && this.#isPinnedAtLiveEnd()) {
					this.#pendingPinnedEnd = {
						viewport,
						windowRevision: this.deps.chatState.windowRevision,
						intentEpoch: this.owner.intentEpoch(),
					};
				}
				this.armIntentWake();
				return;
			}
			if (result === 'loaded' && this.#isPinnedAtLiveEnd()) {
				viewport.scrollToEnd();
			}
			if (result === 'failed') return;
			if (result === 'exhausted') {
				this.#coveragePending = false;
				return;
			}
			if (result === 'invalidated' && before === this.#rawFrontier()) return;
		}
	}

	#isPinnedAtLiveEnd(): boolean {
		return this.owner.isPinnedToBottom() && !this.deps.chatState.hasLaterMessages;
	}

	#restorePendingPinnedEnd(viewport: ConversationViewportPort): void {
		const pending = this.#pendingPinnedEnd;
		this.#pendingPinnedEnd = null;
		if (pending?.viewport === viewport
			&& pending.windowRevision === this.deps.chatState.windowRevision
			&& pending.intentEpoch === this.owner.intentEpoch()
			&& this.#isPinnedAtLiveEnd()
			&& !viewport.isAtEnd()) {
			viewport.scrollToEnd();
		}
	}

	async #measureCoverage(viewport: ConversationViewportPort): Promise<'underfilled' | 'overflow' | 'unsettled' | 'superseded'> {
		this.isMeasuring = true;
		try {
			const layout = await viewport.waitForLayout({ minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision });
			if (layout === 'superseded') return 'superseded';
			if (layout !== 'settled') return 'unsettled';
			return this.owner.isPinnedToBottom() ? await viewport.measureViewportFill() : viewport.readViewportFill();
		} finally {
			this.isMeasuring = false;
		}
	}

	async #allowCoverageChunk(direction: TranscriptPageDirection): Promise<boolean> {
		while (this.#coverageAvailable()) {
			if (this.owner.hasManualPage()) return true;
			if (this.owner.hasRecentIntent()) {
				this.armIntentWake();
				return false;
			}
			if (this.nativeScroll.activity !== 'idle') return false;
			const viewport = this.deps.getViewport();
			if (!viewport) return false;
			if (!viewport.isReady()) {
				this.armMeasurementWake(viewport);
				return false;
			}
			if (this.#isPinnedAtLiveEnd() && this.deps.chatState.hasPendingAnchorDemand(direction)) return true;
			const fill = await this.#measureCoverage(viewport);
			if (!this.#coverageAvailable()) return false;
			if (this.owner.hasManualPage()) return true;
			if (this.owner.hasRecentIntent()) {
				this.armIntentWake();
				return false;
			}
			if (this.nativeScroll.activity !== 'idle') return false;
			if (fill === 'superseded') {
				await this.#yieldLayout();
				continue;
			}
			if (fill === 'unsettled') this.armMeasurementWake(viewport);
			return fill === 'underfilled';
		}
		return false;
	}

	#rawFrontier(): string {
		return `${this.deps.chatState.nextBeforeOrdinal}:${this.deps.chatState.loadedThroughOrdinal}`;
	}

	armMeasurementWake(viewport: ConversationViewportPort): void {
		this.#measurementWakeCleanup?.();
		this.#measurementWakeCleanup = viewport.onNextMeasurement(() => {
			this.#measurementWakeCleanup = null;
			this.wakeCoverage();
		});
	}

	armIntentWake(): void {
		if (this.#intentWakeTimer !== null) clearTimeout(this.#intentWakeTimer);
		this.#intentWakeTimer = null;
		if (!this.deps.chatState.combinedMode || !this.owner.hasRecentIntent() || this.#disposed) return;
		const delay = Math.max(1, USER_SCROLL_INTENT_WINDOW_MS - (performance.now() - this.owner.intentReceivedAt()) + 1);
		this.#intentWakeTimer = setTimeout(() => { this.#intentWakeTimer = null; this.wakeCoverage(); }, delay);
	}

	#yieldLayout(): Promise<void> {
		return new Promise(resolve => requestAnimationFrame(() => resolve()));
	}

	observeQueueResize(): (() => void) | undefined {
		return observeConversationQueueResize(
			this.deps.getQueueContainer(),
			() => this.owner.isVisible() && !this.owner.hasTargetNavigation(),
			() => this.deps.getViewport(),
			() => this.owner.isPinnedToBottom(),
			() => this.owner.scrollToBottom(),
		);
	}

	observeScrollContainerResize(): (() => void) | undefined {
		const scroller = this.deps.getScrollContainer();
		if (!scroller || typeof ResizeObserver === 'undefined') return undefined;
		let previousHeight = scroller.clientHeight;
		let previousWidth = scroller.clientWidth;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? scroller.clientHeight;
			const nextWidth = entries[0]?.contentRect.width ?? scroller.clientWidth;
			if (nextHeight <= 0 || (nextHeight === previousHeight && nextWidth === previousWidth)) return;
			const heightChanged = nextHeight !== previousHeight;
			previousHeight = nextHeight;
			previousWidth = nextWidth;
			if (heightChanged && this.owner.isVisible() && !this.owner.hasTargetNavigation() && this.owner.isPinnedToBottom()) {
				this.owner.scrollToBottom();
			}
			this.wakeCoverage();
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}

	applicationGate(
		chatId: string,
		operationEpoch: number,
		policy: PageApplicationPolicy,
		direction?: TranscriptPageDirection,
	): TranscriptPageApplicationGate | undefined {
		const eligible = direction ? () => this.#allowCoverageChunk(direction) : undefined;
		if (this.deps.chatState.combinedMode) {
			const windowRevision = this.deps.chatState.windowRevision;
			const current = () => !this.#disposed && this.owner.isVisible()
				&& this.deps.chatState.windowRevision === windowRevision
				&& this.owner.isCurrentViewportOperation(chatId, operationEpoch);
			return async () => {
				while (current()) {
					const viewport = this.deps.getViewport();
					if (!viewport?.isReady()) {
						if (viewport) this.armMeasurementWake(viewport);
						return 'invalidated';
					}
					const revision = this.deps.chatState.feedMutationClock.dataRevision;
					const layout = await viewport.waitForLayout({ minimumDataRevision: revision });
					if (!current()) return 'invalidated';
					if (layout !== 'settled') { await this.#yieldLayout(); continue; }
					if (policy === 'after-native-scroll') await this.nativeScroll.waitUntilIdle();
					if (!current()) return 'invalidated';
					if (revision !== this.deps.chatState.feedMutationClock.dataRevision
						|| (policy === 'after-native-scroll' && this.nativeScroll.activity !== 'idle')) continue;
					if (eligible && !(await eligible())) return 'invalidated';
					if (!current()) return 'invalidated';
					if (revision !== this.deps.chatState.feedMutationClock.dataRevision
						|| (policy === 'after-native-scroll' && this.nativeScroll.activity !== 'idle')) continue;
					return 'apply';
				}
				return 'invalidated';
			};
		}
		if (policy === 'immediate') return undefined;
		let decision: ReturnType<TranscriptPageApplicationGate> | null = null;
		return () => {
			decision ??= (async () => {
				const settlement = await this.nativeScroll.waitUntilIdle();
				return settlement === 'settled' &&
					this.owner.isVisible() &&
					this.owner.isCurrentViewportOperation(chatId, operationEpoch)
					? 'apply'
					: 'invalidated';
			})();
			return decision;
		};
	}

	async #waitForCurrentLayout(): Promise<TranscriptPageLoadResult> {
		const layout = await this.deps.getViewport()?.waitForLayout({
			minimumDataRevision: this.deps.chatState.feedMutationClock.dataRevision,
		});
		return layout === 'settled' ? 'loaded' : 'invalidated';
	}

}
