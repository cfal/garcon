import { tick, untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Readable, Unsubscriber } from 'svelte/store';
import { createVirtualizer, type Range, type SvelteVirtualizer } from '@tanstack/svelte-virtual';
import type {
	ConversationLayoutWaitResult,
	ConversationViewportFillResult,
	ConversationViewportPort,
	ConversationViewportTarget,
	ConversationViewportTargetResult,
	HiddenReadingRestoreResult,
} from '$lib/chat/transcript/conversation-viewport-port.js';
import type { ConversationVirtualGeometrySnapshot } from './ConversationFeedProjectionState.svelte.js';
import {
	CHAT_GEOMETRY_END_THRESHOLD_PX,
	classifyConversationVirtualStructure,
	classifyMeasuredConversationViewportFill,
	createRetainedConversationRangeExtractor,
	shouldPreserveConversationVirtualEdge,
} from './conversation-feed-viewport-geometry.js';
import type { ConversationVirtualFeedModel } from './conversation-feed-virtual-items.js';
import {
	captureConversationVirtualAnchor,
	type ConversationVirtualAnchor,
	conversationAnchorScrollOffset,
	createConversationElementRectObserver,
	ConversationMountedVirtualItems,
	ConversationPreCommitAnchorBuffer,
	nextConversationAnimationFrame as nextAnimationFrame,
	nextConversationLayoutFrame,
	observeConversationRootOffset,
	sameConversationNumberArrays,
	settleConversationEndRestore,
	settleConversationScroll,
	settleConversationTarget,
	scrollConversationToPhysicalEnd,
} from './conversation-feed-virtual-runtime.js';
import type { ConversationFeedRetentionState } from './ConversationFeedRetentionState.svelte.js';

export const CHAT_VIRTUAL_OVERSCAN = 6;
const CHAT_FALLBACK_VIEWPORT_HEIGHT = 720;
const MAX_SETTLE_ITERATIONS = 8;
const OFFSET_TOLERANCE_PX = 0.5;
interface ConversationFeedVirtualControllerOptions {
	get model(): ConversationVirtualFeedModel;
	get geometry(): ConversationVirtualGeometrySnapshot;
	get projectedDataRevision(): number;
	get viewport(): HTMLDivElement | null;
	get virtualRoot(): HTMLDivElement | null;
	get visible(): boolean;
	get pinned(): boolean;
	get retention(): ConversationFeedRetentionState;
	onInitialEndRestored?(): void;
}
export class ConversationFeedVirtualController implements ConversationViewportPort {
	readonly virtualizer: Readable<SvelteVirtualizer<HTMLElement, HTMLDivElement>>;

	#instanceValue!: SvelteVirtualizer<HTMLElement, HTMLDivElement>;
	#unsubscribe: Unsubscriber;
	#virtualScrollElement: HTMLDivElement | null;
	#configuredGeometryRevision: number;
	#configuredSurfaceIdentity: string;
	#configuredKeys: readonly string[];
	#configuredEstimates: readonly number[];
	#configuredTranscriptKeys: ReadonlySet<string>;
	#configuredRetainedIndexes: readonly number[] = [];
	#configuredTrailingStartIndex: number;
	#configuredPinned: boolean;
	#appliedDataRevision: number;
	#configuredVisible: boolean;
	// Cancellation ownership stays field-specific. Structural publication, visibility, targets, user
	// intent, replacement, and teardown advance the layout token to invalidate deferred anchor/end writes.
	// New targets, user intent, replacement, and teardown advance the target token. Programmatic epochs
	// supersede TanStack scroll operations; user intent advances both epochs and may supersede core's active
	// target. The initial-end epoch owns only the deferred initial/latest restore. The user-intent epoch
	// prevents older scale/end work from restoring after a genuine gesture. Active targets suppress passive
	// writes until their balanced finally block exits. Pending and hidden anchors carry one keyed reading
	// position; pending end and measure-on-show carry one deferred viewport operation for the current surface.
	#layoutMutationToken = 0;
	#targetToken = 0;
	#hiddenAnchor: ConversationVirtualAnchor | null = null;
	#hiddenScrollOffset: number | null = null;
	#pendingReadingAnchor: ConversationVirtualAnchor | null = null;
	#readingRestoreGeneration = 0;
	#preCommitAnchorBuffer = new ConversationPreCommitAnchorBuffer();
	#measureOnShow = false;
	#pendingEndScroll = false;
	#programmaticScrollActive = false;
	#programmaticScrollEpoch = 0;
	#initialEndRestoreEpoch = 0;
	#activeTargetScrolls = 0;
	#userIntentEpoch = 0;
	#scrollMargin = 0;
	#observeElementRect = createConversationElementRectObserver({
		width: 0,
		height: CHAT_FALLBACK_VIEWPORT_HEIGHT,
	});
	// Keys whose wrappers have rendered for the current surface and styling; cleared with
	// the measurement cache on surface replacement and global invalidation.
	#renderedKeys = new Set<string>();
	// The live element set follows attachment cleanup while keyed wrappers may change index in place.
	#mountedItems = new ConversationMountedVirtualItems();
	#destroyed = false;

	constructor(private readonly options: ConversationFeedVirtualControllerOptions) {
		const geometry = untrack(() => options.geometry);
		const model = untrack(() => options.model);
		this.#configuredGeometryRevision = geometry.geometryRevision;
		this.#configuredSurfaceIdentity = geometry.surfaceIdentity;
		this.#configuredKeys = geometry.keys;
		this.#configuredEstimates = geometry.estimates;
		this.#configuredTranscriptKeys = new Set(
			model.items.flatMap((item) => (item.kind === 'transcript' ? [item.key] : [])),
		);
		const indexByKey = new Map(geometry.keys.map((key, index) => [key, index] as const));
		this.#configuredRetainedIndexes = untrack(() => options.retention.retainedKeys).flatMap(
			(key) => {
				const index = indexByKey.get(key);
				return index === undefined ? [] : [index];
			},
		);
		this.#configuredTrailingStartIndex = Math.max(
			model.transcriptStartIndex,
			model.transcriptEndIndex - 1,
		);
		this.#appliedDataRevision = untrack(() => options.projectedDataRevision);
		this.#configuredVisible = untrack(() => options.visible);
		this.#configuredPinned = untrack(() => options.pinned);
		this.#virtualScrollElement = this.#configuredVisible ? untrack(() => options.viewport) : null;
		const keys = geometry.keys;
		const estimates = geometry.estimates;

		this.virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
			count: keys.length,
			getScrollElement: this.#getScrollElement,
			getItemKey: (index) => keys[index] ?? `missing:${index}`,
			estimateSize: (index) => estimates[index] ?? 120,
			initialRect: { width: 0, height: CHAT_FALLBACK_VIEWPORT_HEIGHT },
			observeElementRect: this.#observeElementRect,
			overscan: CHAT_VIRTUAL_OVERSCAN,
			anchorTo: 'end',
			followOnAppend: false,
			scrollEndThreshold: CHAT_GEOMETRY_END_THRESHOLD_PX,
			useCachedMeasurements: !this.#configuredVisible,
			rangeExtractor: this.#createRangeExtractor(),
		});
		this.#unsubscribe = this.virtualizer.subscribe((instance) => {
			this.#instanceValue = instance;
		});
		$effect(() => this.#acknowledgeData(options.projectedDataRevision));
		$effect(() => {
			const snapshot = options.geometry;
			// Geometry publication tracks only the snapshot; visibility, viewport, pinned,
			// and retention transitions are owned by their dedicated effects.
			untrack(() => this.#publishGeometry(snapshot));
		});
		$effect(() => this.#publishRetention(options.retention.retainedKeys));
		$effect(() => this.#publishPinned(options.pinned));
		$effect(() => this.#publishVisibility());
		$effect(() => this.#observeRootOffset());
	}

	// Captures the committed reading row before the caller publishes new geometry.
	prepareForGeometryPublication(geometryRevision: number): void {
		if (this.#destroyed || geometryRevision === this.#configuredGeometryRevision) return;
		this.#preCommitAnchorBuffer.capture(geometryRevision, (preferTranscript) =>
			this.#captureVirtualAnchor(preferTranscript),
		);
	}

	measureItem: Attachment<HTMLDivElement> = (element) => {
		this.#mountedItems.add(element);
		this.#instance().measureElement(element);
		// A rendered wrapper is measured even when TanStack omits its cache entry
		// because the rendered size equals the estimate.
		const key = this.#configuredKeys[Number(element.dataset.index)];
		if (key !== undefined) this.#renderedKeys.add(key);
		return () => {
			this.#mountedItems.delete(element);
			this.#instance().measureElement(null);
		};
	};

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#initialEndRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#hiddenAnchor = null;
		this.#hiddenScrollOffset = null;
		this.#measureOnShow = false;
		this.#pendingEndScroll = false;
		this.#virtualScrollElement = null;
		this.#preCommitAnchorBuffer.clear();
		this.#mountedItems.clear();
		this.#instance().setOptions({
			getScrollElement: this.#getScrollElement,
			useCachedMeasurements: true,
		});
		this.#unsubscribe();
	}

	prepareForHide(): void {
		if (this.#destroyed || !this.#configuredVisible) return;
		this.#initialEndRestoreEpoch += 1;
		if (!this.options.pinned) {
			this.#hiddenAnchor = this.#captureVirtualAnchor(true);
			this.#hiddenScrollOffset = this.options.viewport?.scrollTop ?? null;
		}
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#configuredVisible = false;
		this.#virtualScrollElement = null;
		this.#instance().setOptions({
			getScrollElement: this.#getScrollElement,
			useCachedMeasurements: true,
		});
	}

	isReady(): boolean {
		return Boolean(!this.#destroyed && this.options.visible && this.options.viewport);
	}

	isAtEnd(threshold = CHAT_GEOMETRY_END_THRESHOLD_PX): boolean {
		const viewport = this.options.viewport;
		return Boolean(
			this.isReady() &&
			viewport &&
			viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= threshold,
		);
	}

	scrollToStart(): void {
		if (!this.isReady()) return;
		this.#initialEndRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		this.#instance().scrollToOffset(0, { behavior: 'auto' });
		void this.#completeSimpleScroll(operationEpoch, this.#layoutMutationToken);
	}

	scrollToEnd(): void {
		if (this.#destroyed) return;
		if (!this.isReady()) {
			this.#pendingEndScroll = true;
			return;
		}
		this.#initialEndRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		const resetMeasurements = this.#measureOnShow;
		this.#measureOnShow = false;
		const surfaceIdentity = this.options.geometry.surfaceIdentity;
		this.#hiddenAnchor = null;
		this.#hiddenScrollOffset = null;
		this.#pendingEndScroll = false;
		const layoutToken = this.#layoutMutationToken;
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		this.#scrollToPhysicalEnd();
		if (resetMeasurements) {
			void this.#completeEndRestoreAfterMeasurement(layoutToken, operationEpoch, surfaceIdentity);
		} else {
			void this.#completeEndRestore(layoutToken, operationEpoch);
		}
	}

	restoreInitialEnd(): void {
		if (this.#destroyed) return;
		if (!this.isReady()) {
			this.#pendingEndScroll = true;
			return;
		}
		this.#cancelTargetScroll();
		const restoreEpoch = ++this.#initialEndRestoreEpoch;
		const surfaceIdentity = this.options.geometry.surfaceIdentity;
		void this.#restoreInitialEndAfterCommit(restoreEpoch, surfaceIdentity);
	}

	scrollBy(delta: number): void {
		if (!this.isReady()) return;
		this.#initialEndRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		this.#instance().scrollBy(delta, { behavior: 'auto' });
		void this.#completeSimpleScroll(operationEpoch, this.#layoutMutationToken);
	}

	async waitForLayout(
		options: { minimumDataRevision?: number } = {},
	): Promise<ConversationLayoutWaitResult> {
		if (!this.isReady()) return 'not-ready';
		const token = this.#layoutMutationToken;
		let previousOffset: number | null = null;
		for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
			await nextConversationLayoutFrame();
			if (token !== this.#layoutMutationToken) return 'superseded';
			const viewport = this.options.viewport;
			if (!viewport || !this.options.visible) return 'not-ready';
			const currentOffset = viewport.scrollTop;
			const dataReady =
				options.minimumDataRevision === undefined ||
				this.#appliedDataRevision >= options.minimumDataRevision;
			const stable =
				previousOffset !== null && Math.abs(currentOffset - previousOffset) <= OFFSET_TOLERANCE_PX;
			if (dataReady && stable) return 'settled';
			previousOffset = currentOffset;
		}
		return 'not-ready';
	}

	async measureViewportFill(): Promise<ConversationViewportFillResult> {
		if (!this.isReady()) return 'unsettled';
		const keys = this.#configuredKeys;
		if (keys.length === 0) return 'underfilled';
		const token = this.#layoutMutationToken;
		const restoreEnd = this.options.pinned;
		const readingAnchor = restoreEnd ? null : this.#captureVirtualAnchor(true);
		const operationEpoch = this.#beginProgrammaticScrollOperation();

		try {
			for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
				await nextConversationLayoutFrame();
				if (
					token !== this.#layoutMutationToken ||
					!this.#isCurrentProgrammaticScrollOperation(operationEpoch) ||
					!this.isReady()
				) {
					return 'unsettled';
				}
				const viewport = this.options.viewport;
				if (!viewport) return 'unsettled';
				const instance = this.#instance();
				const classification = classifyMeasuredConversationViewportFill({
					keys,
					measuredSizes: instance.itemSizeCache,
					renderedKeys: this.#renderedKeys,
					estimates: this.#configuredEstimates,
					leadingSize: this.#scrollMargin,
					viewportHeight: viewport.clientHeight,
				});
				if (classification) {
					if (restoreEnd) this.#scrollToPhysicalEnd();
					else if (readingAnchor && !(await this.#restoreVirtualAnchor(readingAnchor, false))) {
						return 'unsettled';
					}
					return classification;
				}
				const nextUnmeasuredIndex = keys.findIndex(
					(key) => !instance.itemSizeCache.has(key) && !this.#renderedKeys.has(key),
				);
				if (nextUnmeasuredIndex < 0) return 'unsettled';
				instance.scrollToIndex(nextUnmeasuredIndex, { align: 'start', behavior: 'auto' });
			}
			if (
				restoreEnd &&
				this.#isCurrentProgrammaticScrollOperation(operationEpoch) &&
				this.isReady()
			) {
				this.#scrollToPhysicalEnd();
			} else if (readingAnchor) await this.#restoreVirtualAnchor(readingAnchor, false);
			return 'unsettled';
		} finally {
			this.#finishProgrammaticScrollOperation(operationEpoch);
		}
	}

	async restoreHiddenReadingPosition(): Promise<HiddenReadingRestoreResult> {
		const anchor = this.#hiddenAnchor;
		const scrollOffset = this.#hiddenScrollOffset;
		this.#hiddenAnchor = null;
		this.#hiddenScrollOffset = null;
		if (!this.isReady()) return 'not-ready';
		const userIntentEpoch = this.#userIntentEpoch;
		const layoutToken = this.#layoutMutationToken;
		const resetMeasurements = this.#measureOnShow;
		this.#measureOnShow = false;
		const surfaceIdentity = this.options.geometry.surfaceIdentity;
		// A raw stored offset is only meaningful on the surface it was captured from, so every
		// offset write deferred past an await revalidates surface identity, readiness, and the
		// user-intent epoch before touching the viewport.
		const offsetWriteStillValid = (): boolean =>
			this.isReady() &&
			this.options.geometry.surfaceIdentity === surfaceIdentity &&
			userIntentEpoch === this.#userIntentEpoch;
		if (!anchor) {
			if (resetMeasurements) {
				const measured = await this.#measureAfterCommit(surfaceIdentity);
				if (!measured) return this.isReady() ? 'missing-anchor' : 'not-ready';
			}
			if (scrollOffset === null) return 'missing-anchor';
			// Nothing on this path advances the layout token itself, so a moved token means a
			// structural publication landed mid-restore and now owns the viewport position.
			if (!offsetWriteStillValid() || layoutToken !== this.#layoutMutationToken) {
				return 'missing-anchor';
			}
			this.#instance().scrollToOffset(scrollOffset, { behavior: 'auto' });
			return 'restored';
		}
		// Carries the hide-time key through a same-surface geometry publication that
		// races the show restore. The newer publication reuses this anchor instead of
		// capturing the temporarily clamped offset under its new measurements.
		this.#pendingReadingAnchor = anchor;
		const restoreGeneration = ++this.#readingRestoreGeneration;
		if (await this.#restoreVirtualAnchor(anchor, resetMeasurements)) {
			if (
				this.#pendingReadingAnchor === anchor &&
				this.#readingRestoreGeneration === restoreGeneration
			) {
				this.#pendingReadingAnchor = null;
			}
			return 'restored';
		}
		if (this.#pendingReadingAnchor !== anchor) return 'missing-anchor';
		if (this.#readingRestoreGeneration !== restoreGeneration) {
			// A newer geometry publication has already scheduled this retained anchor.
			return 'restored';
		}
		this.#pendingReadingAnchor = null;
		// The anchor restore advances the layout token internally, so identity, readiness, and
		// the user-intent epoch are the coherent guards for its raw offset fallback.
		if (scrollOffset === null || !offsetWriteStillValid()) return 'missing-anchor';
		this.#instance().scrollToOffset(scrollOffset, { behavior: 'auto' });
		return 'restored';
	}

	cancelPendingLayoutMutation(): void {
		this.#layoutMutationToken += 1;
		this.#readingRestoreGeneration += 1;
		this.#pendingReadingAnchor = null;
		this.#programmaticScrollActive = false;
		this.#programmaticScrollEpoch += 1;
	}

	cancelForUserIntent(): void {
		this.#userIntentEpoch += 1;
		this.#initialEndRestoreEpoch += 1;
		this.#cancelTargetScroll();
		const shouldSupersedeCore = this.#programmaticScrollActive;
		const viewport = this.options.viewport;
		this.cancelPendingLayoutMutation();
		if (shouldSupersedeCore && viewport && this.isReady()) {
			this.#instance().scrollToOffset(viewport.scrollTop, { behavior: 'auto' });
		}
		this.options.onInitialEndRestored?.();
	}

	async scrollToTarget(
		target: ConversationViewportTarget,
		options: { align?: 'center' | 'start' | 'end' } = {},
	): Promise<ConversationViewportTargetResult> {
		if (!this.isReady()) return 'not-ready';
		this.#initialEndRestoreEpoch += 1;
		this.#activeTargetScrolls += 1;
		try {
			this.#cancelTargetScroll();
			this.cancelPendingLayoutMutation();
			const token = this.#targetToken;
			await nextConversationLayoutFrame();
			if (token !== this.#targetToken) return 'cancelled';
			if (!this.isReady()) return 'not-ready';
			this.cancelPendingLayoutMutation();
			const model = this.options.model;
			const resolved =
				target.kind === 'row'
					? (() => {
							const index = model.indexByRowId.get(target.id);
							return index === undefined ? undefined : { index, innerRowId: target.id };
						})()
					: model.targetByDomAnchorId.get(target.id);
			if (!resolved) return 'target-missing';
			const key = model.items[resolved.index]?.key;
			if (!key) return 'target-missing';

			const operationEpoch = this.#beginProgrammaticScrollOperation();
			const releaseTarget = this.options.retention.acquire(key, 'target');
			try {
				this.#instance().scrollToIndex(resolved.index, {
					align: options.align ?? 'center',
					behavior: 'auto',
				});
				return await settleConversationTarget({
					root: () => this.options.virtualRoot,
					rowId: resolved.innerRowId,
					viewport: () => this.options.viewport,
					align: options.align ?? 'center',
					isCurrent: () =>
						token === this.#targetToken &&
						this.#isCurrentProgrammaticScrollOperation(operationEpoch),
					isReady: () => this.isReady(),
					scrollToOffset: (offset) => this.#instance().scrollToOffset(offset, { behavior: 'auto' }),
				});
			} finally {
				releaseTarget();
				this.#finishProgrammaticScrollOperation(operationEpoch);
			}
		} finally {
			this.#activeTargetScrolls -= 1;
		}
	}

	#acknowledgeData(projectedDataRevision: number): void {
		this.#appliedDataRevision = Math.max(this.#appliedDataRevision, projectedDataRevision);
	}

	#publishGeometry(snapshot: ConversationVirtualGeometrySnapshot): void {
		if (snapshot.geometryRevision === this.#configuredGeometryRevision) return;
		const model = untrack(() => this.options.model);
		const identityChanged = snapshot.surfaceIdentity !== this.#configuredSurfaceIdentity;
		const keys = snapshot.keys;
		const estimates = snapshot.estimates;
		const structure = classifyConversationVirtualStructure({
			identityChanged,
			previousKeys: this.#configuredKeys,
			previousEstimates: this.#configuredEstimates,
			nextKeys: keys,
			nextEstimates: estimates,
		});
		const restorePolicyEnd =
			snapshot.endBehavior === 'restore-if-pinned' && untrack(() => this.options.pinned);
		// The pinned core carries upstream #1246, so count shrink preserves surviving keyed
		// measurements and ignores stale connected indexes without a Garcon reset pass.
		const resetMeasurements = snapshot.measurementReset === 'all';
		// The pre-commit anchor records old TanStack coordinates; the keyed restore applies them
		// after Svelte commits the new sizer.
		const preserveEdgeReadingPosition = shouldPreserveConversationVirtualEdge({
			structure,
			endBehavior: snapshot.endBehavior,
			restorePolicyEnd,
		});
		const shouldCaptureReadingPosition =
			this.options.visible &&
			this.#activeTargetScrolls === 0 &&
			(structure === 'interior-only' || resetMeasurements || preserveEdgeReadingPosition) &&
			snapshot.endBehavior !== 'explicit-navigation' &&
			!identityChanged;
		const preferTranscriptAnchor = resetMeasurements || preserveEdgeReadingPosition;
		const preCommitAnchor = this.#preCommitAnchorBuffer.take(
			snapshot.geometryRevision,
			preferTranscriptAnchor,
		);
		const preservationAnchor = shouldCaptureReadingPosition
			? (this.#pendingReadingAnchor ??
				preCommitAnchor ??
				this.#captureVirtualAnchor(preferTranscriptAnchor))
			: null;
		if (preservationAnchor && !restorePolicyEnd) {
			this.#pendingReadingAnchor = preservationAnchor;
		} else if (!shouldCaptureReadingPosition || restorePolicyEnd) {
			this.#pendingReadingAnchor = null;
		}

		if (identityChanged) this.#detachAndResetOldSurface();
		const indexByKey = new Map(keys.map((key, index) => [key, index] as const));
		const retainedIndexes = untrack(() => {
			this.options.retention.prune(indexByKey.keys());
			return this.options.retention.retainedKeys.flatMap((key) => {
				const index = indexByKey.get(key);
				return index === undefined ? [] : [index];
			});
		});
		this.#configuredRetainedIndexes = retainedIndexes;
		this.#configuredTrailingStartIndex = Math.max(
			model.transcriptStartIndex,
			model.transcriptEndIndex - 1,
		);
		const instance = this.#instance();
		instance.setOptions({
			count: keys.length,
			getScrollElement: this.#getScrollElement,
			getItemKey: (index) => keys[index] ?? `missing:${index}`,
			estimateSize: (index) => estimates[index] ?? 120,
			initialRect: { width: 0, height: CHAT_FALLBACK_VIEWPORT_HEIGHT },
			overscan: CHAT_VIRTUAL_OVERSCAN,
			anchorTo: 'end',
			followOnAppend: false,
			scrollEndThreshold: CHAT_GEOMETRY_END_THRESHOLD_PX,
			scrollMargin: this.#scrollMargin,
			useCachedMeasurements: !this.options.visible,
			rangeExtractor: this.#createRangeExtractor(),
		});
		instance.getVirtualItems();

		this.#configuredGeometryRevision = snapshot.geometryRevision;
		this.#configuredSurfaceIdentity = snapshot.surfaceIdentity;
		this.#configuredKeys = keys;
		this.#configuredEstimates = estimates;
		this.#configuredTranscriptKeys = new Set(
			model.items.flatMap((item) => (item.kind === 'transcript' ? [item.key] : [])),
		);
		if (identityChanged) this.#publishVisibility(true);
		const layoutToken = ++this.#layoutMutationToken;
		if (!this.options.visible) {
			if (resetMeasurements) this.#measureOnShow = true;
			return;
		}
		if (this.#activeTargetScrolls > 0) {
			if (resetMeasurements) {
				void this.#resetMeasurementsAfterCommit(snapshot, false, this.#userIntentEpoch);
			}
			return;
		}

		// A concurrent viewport resize can request the same pinned-end restore before the scale reset
		// commits. The required cache reset therefore validates semantic ownership, not the layout token.
		if (resetMeasurements && restorePolicyEnd) {
			void this.#resetMeasurementsAfterCommit(snapshot, true, this.#userIntentEpoch);
		} else if (resetMeasurements && preservationAnchor) {
			this.#scheduleReadingRestore(preservationAnchor, true);
		} else if (resetMeasurements) {
			void this.#resetMeasurementsAfterCommit(snapshot, false, this.#userIntentEpoch);
		} else if (restorePolicyEnd) {
			void this.#restorePolicyEndAfterCommit(layoutToken, snapshot);
		} else if (preservationAnchor) {
			this.#scheduleReadingRestore(preservationAnchor, false);
		}
	}

	#publishRetention(retainedKeys: readonly string[]): void {
		const indexByKey = new Map(this.#configuredKeys.map((key, index) => [key, index] as const));
		const retainedIndexes = retainedKeys.flatMap((key) => {
			const index = indexByKey.get(key);
			return index === undefined ? [] : [index];
		});
		if (sameConversationNumberArrays(retainedIndexes, this.#configuredRetainedIndexes)) return;
		this.#configuredRetainedIndexes = retainedIndexes;
		this.#instance().setOptions({
			rangeExtractor: this.#createRangeExtractor(),
		});
	}

	#publishPinned(pinned: boolean): void {
		if (pinned === this.#configuredPinned) return;
		this.#configuredPinned = pinned;
		this.#instance().setOptions({ rangeExtractor: this.#createRangeExtractor() });
	}

	#publishVisibility(force = false): void {
		const visible = this.options.visible;
		const viewport = visible ? this.options.viewport : null;
		if (!force && visible === this.#configuredVisible && viewport === this.#virtualScrollElement) {
			return;
		}
		this.#initialEndRestoreEpoch += 1;
		if (!visible && this.#configuredVisible && !this.options.pinned) {
			this.#hiddenAnchor = this.#captureVirtualAnchor(true);
			this.#hiddenScrollOffset = this.options.viewport?.scrollTop ?? null;
		}
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#configuredVisible = visible;
		this.#virtualScrollElement = viewport;
		const instance = this.#instance();
		instance.setOptions({
			getScrollElement: this.#getScrollElement,
			useCachedMeasurements: !visible,
		});
		instance.getVirtualItems();
		if (!visible) return;
		if (this.#pendingEndScroll) {
			this.scrollToEnd();
		}
	}

	#observeRootOffset(): (() => void) | undefined {
		const viewport = this.options.viewport;
		const root = this.options.virtualRoot;
		if (!this.options.visible || !viewport || !root) return;
		return observeConversationRootOffset(viewport, root, (margin) => {
			if (Math.abs(margin - this.#scrollMargin) <= OFFSET_TOLERANCE_PX) return;
			// A late root-offset change moves the physical end outside TanStack's own
			// anchoring, so a pinned viewport resting at the end re-pins after the update.
			const repinEnd =
				untrack(() => this.options.pinned) &&
				this.#activeTargetScrolls === 0 &&
				this.isAtEnd(Math.abs(margin - this.#scrollMargin) + CHAT_GEOMETRY_END_THRESHOLD_PX);
			this.#scrollMargin = margin;
			this.#instance().setOptions({ scrollMargin: margin });
			if (repinEnd && this.isReady()) this.#scrollToPhysicalEnd();
		});
	}

	#detachAndResetOldSurface(): void {
		this.#initialEndRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#virtualScrollElement = null;
		this.#instance().setOptions({
			getScrollElement: this.#getScrollElement,
			useCachedMeasurements: true,
		});
		this.options.retention.clear();
		this.#hiddenAnchor = null;
		this.#hiddenScrollOffset = null;
		this.#pendingEndScroll = false;
		this.#measureOnShow = false;
		this.#renderedKeys.clear();
		this.#mountedItems.clear();
		this.#instance().measure();
	}

	#captureVirtualAnchor(preferTranscript = false): ConversationVirtualAnchor | null {
		let transcriptKeys = this.#configuredTranscriptKeys;
		if (preferTranscript) {
			const attachedTranscriptKeys = this.#mountedItems.transcriptKeys(
				this.#configuredKeys,
				this.#configuredTranscriptKeys,
			);
			// A structural update can start after core publishes its range but before Svelte
			// commits every wrapper. The anchor follows a row the reader can actually see.
			if (attachedTranscriptKeys.size > 0) transcriptKeys = attachedTranscriptKeys;
		}
		return captureConversationVirtualAnchor({
			instance: this.#instance(),
			viewport: this.options.viewport,
			keys: this.#configuredKeys,
			transcriptKeys,
			preferTranscript,
		});
	}

	async #restoreVirtualAnchor(
		anchor: ConversationVirtualAnchor,
		resetMeasurements: boolean,
	): Promise<boolean> {
		const token = ++this.#layoutMutationToken;
		const initialModel = this.options.model;
		const initialKey = [anchor.key, ...anchor.fallbackKeys].find((candidate) =>
			initialModel.indexByKey.has(candidate),
		);
		if (!initialKey) return false;
		const release = this.options.retention.acquire(initialKey, 'target');
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		try {
			if (resetMeasurements) {
				// A failed measure already re-arms measure-on-show inside #measureAfterCommit.
				if (!(await this.#measureAfterCommit(this.options.geometry.surfaceIdentity))) {
					return false;
				}
				if (!this.#isCurrentLayoutOperation(token, operationEpoch)) return false;
			}
			const model = this.options.model;
			const key = [anchor.key, ...anchor.fallbackKeys].find((candidate) =>
				model.indexByKey.has(candidate),
			);
			if (!key) return false;
			const index = model.indexByKey.get(key);
			if (index === undefined) return false;
			this.#instance().scrollToIndex(index, { align: 'start', behavior: 'auto' });
			for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
				await nextConversationLayoutFrame();
				if (
					token !== this.#layoutMutationToken ||
					!this.#isCurrentProgrammaticScrollOperation(operationEpoch) ||
					!this.isReady()
				) {
					return false;
				}
				const item = this.#instance()
					.getVirtualItems()
					.find((candidate) => candidate.key === key);
				if (!item) continue;
				const viewportOffset = key === anchor.key ? anchor.viewportOffset : 0;
				const scrollOffset = conversationAnchorScrollOffset(
					item.start,
					this.#instance().options.scrollMargin,
					viewportOffset,
				);
				this.#instance().scrollToOffset(scrollOffset, { behavior: 'auto' });
				await nextAnimationFrame();
				if (
					token !== this.#layoutMutationToken ||
					!this.#isCurrentProgrammaticScrollOperation(operationEpoch) ||
					!this.isReady()
				) {
					return false;
				}
				const settledItem = this.#instance()
					.getVirtualItems()
					.find((candidate) => candidate.key === key);
				const settledOffset = this.options.viewport?.scrollTop ?? this.#instance().scrollOffset;
				if (
					settledItem &&
					settledOffset != null &&
					Math.abs(
						settledOffset -
							conversationAnchorScrollOffset(
								settledItem.start,
								this.#instance().options.scrollMargin,
								viewportOffset,
							),
					) <= OFFSET_TOLERANCE_PX
				) {
					return true;
				}
			}
			return false;
		} finally {
			release();
			this.#finishProgrammaticScrollOperation(operationEpoch);
		}
	}

	#scheduleReadingRestore(anchor: ConversationVirtualAnchor, resetMeasurements: boolean): void {
		const restoreGeneration = ++this.#readingRestoreGeneration;
		void this.#restoreVirtualAnchor(anchor, resetMeasurements).then(() => {
			if (
				this.#pendingReadingAnchor !== anchor ||
				this.#readingRestoreGeneration !== restoreGeneration
			) {
				return;
			}
			// The latest attempt consumes its anchor even when layout never settles. Only a
			// newer scheduled attempt may carry the same anchor across a passive supersession.
			this.#pendingReadingAnchor = null;
		});
	}

	async #restorePolicyEndAfterCommit(
		token: number,
		snapshot: ConversationVirtualGeometrySnapshot,
	): Promise<void> {
		// Writes the end offset after the sizer commits but before the browser paints,
		// so a pinned publication never paints a frame at the pre-mutation offset. The
		// scrollToEnd convergence loop still verifies across later measurement frames.
		await tick();
		if (
			token !== this.#layoutMutationToken ||
			!this.isReady() ||
			this.#activeTargetScrolls > 0 ||
			!this.options.pinned ||
			this.options.geometry.geometryRevision !== snapshot.geometryRevision ||
			this.options.geometry.endBehavior !== 'restore-if-pinned'
		) {
			return;
		}
		this.scrollToEnd();
	}

	async #resetMeasurementsAfterCommit(
		snapshot: ConversationVirtualGeometrySnapshot,
		restorePolicyEnd: boolean,
		userIntentEpoch: number,
	): Promise<void> {
		const measured = await this.#measureAfterCommit(snapshot.surfaceIdentity);
		if (!measured) return;
		await nextConversationLayoutFrame();
		if (
			restorePolicyEnd &&
			this.#activeTargetScrolls === 0 &&
			userIntentEpoch === this.#userIntentEpoch &&
			this.isReady() &&
			this.options.pinned &&
			this.options.geometry.geometryRevision === snapshot.geometryRevision &&
			this.options.geometry.endBehavior === 'restore-if-pinned'
		) {
			this.scrollToEnd();
		}
	}

	async #measureAfterCommit(surfaceIdentity: string): Promise<boolean> {
		await nextConversationLayoutFrame();
		if (this.#destroyed || this.options.geometry.surfaceIdentity !== surfaceIdentity) {
			return false;
		}
		if (!this.options.visible) {
			this.#measureOnShow = true;
			return false;
		}
		if (!this.isReady()) return false;
		this.#renderedKeys.clear();
		this.#instance().measure();
		return true;
	}

	async #completeEndRestoreAfterMeasurement(
		token: number,
		operationEpoch: number,
		surfaceIdentity: string,
	): Promise<void> {
		await this.#measureAfterCommit(surfaceIdentity);
		if (this.#isCurrentLayoutOperation(token, operationEpoch)) this.#scrollToPhysicalEnd();
		await this.#completeEndRestore(token, operationEpoch);
	}

	async #completeEndRestore(token: number, operationEpoch: number): Promise<void> {
		try {
			await settleConversationEndRestore({
				isCurrent: () => this.#isCurrentLayoutOperation(token, operationEpoch),
				readGeometry: () => {
					const viewport = this.options.viewport;
					return viewport
						? {
								scrollHeight: viewport.scrollHeight,
								totalSize: this.#instance().getTotalSize(),
								virtualRange: this.#committedVirtualRangeSignature(),
							}
						: null;
				},
				isAtEnd: () => this.isAtEnd(),
				scrollToEnd: () => this.#scrollToPhysicalEnd(),
				complete: () => this.options.onInitialEndRestored?.(),
			});
		} finally {
			this.#finishProgrammaticScrollOperation(operationEpoch);
		}
	}

	async #restoreInitialEndAfterCommit(
		restoreEpoch: number,
		surfaceIdentity: string,
	): Promise<void> {
		// Positions before the first paint of the committed sizer; the convergence loop
		// owns later measurement-driven corrections.
		await tick();
		if (
			restoreEpoch !== this.#initialEndRestoreEpoch ||
			surfaceIdentity !== this.#configuredSurfaceIdentity ||
			this.#activeTargetScrolls > 0 ||
			!this.isReady()
		) {
			return;
		}
		this.scrollToEnd();
	}

	#scrollToPhysicalEnd(): void {
		scrollConversationToPhysicalEnd(this.#instance(), this.options.viewport);
	}

	#committedVirtualRangeSignature(): string | null {
		// Delayed measurements can expand the range until TanStack closes its scroll cycle.
		if (this.#instance().isScrolling) return null;
		return this.#mountedItems.committedRangeSignature(
			this.#instance().getVirtualItems(),
			this.#configuredKeys,
		);
	}

	async #completeSimpleScroll(operationEpoch: number, token: number): Promise<void> {
		try {
			await settleConversationScroll({
				isCurrent: () => this.#isCurrentLayoutOperation(token, operationEpoch),
				readOffset: () => this.options.viewport?.scrollTop ?? null,
			});
		} finally {
			this.#finishProgrammaticScrollOperation(operationEpoch);
		}
	}

	#beginProgrammaticScrollOperation(): number {
		this.#programmaticScrollActive = true;
		return ++this.#programmaticScrollEpoch;
	}

	#isCurrentProgrammaticScrollOperation(epoch: number): boolean {
		return epoch === this.#programmaticScrollEpoch;
	}
	#isCurrentLayoutOperation(token: number, epoch: number): boolean {
		return (
			token === this.#layoutMutationToken &&
			this.#isCurrentProgrammaticScrollOperation(epoch) &&
			this.isReady()
		);
	}

	#finishProgrammaticScrollOperation(epoch: number): void {
		if (epoch !== this.#programmaticScrollEpoch) return;
		this.#programmaticScrollActive = false;
	}

	#cancelTargetScroll(): void {
		this.#targetToken += 1;
	}

	#getScrollElement = (): HTMLDivElement | null => this.#virtualScrollElement;

	#createRangeExtractor(): (range: Range) => number[] {
		const trailingStartIndex = this.#configuredPinned
			? this.#configuredTrailingStartIndex
			: undefined;
		return createRetainedConversationRangeExtractor(
			this.#configuredRetainedIndexes,
			trailingStartIndex,
		);
	}

	#instance(): SvelteVirtualizer<HTMLElement, HTMLDivElement> {
		return this.#instanceValue;
	}
}
