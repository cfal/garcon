import { tick, untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Readable, Unsubscriber } from 'svelte/store';
import {
	createVirtualizer,
	observeElementRect,
	type Range,
	type Rect,
	type SvelteVirtualizer,
	type Virtualizer,
} from '@tanstack/svelte-virtual';
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
	attainableConversationTargetOffset,
	CHAT_GEOMETRY_END_THRESHOLD_PX,
	classifyConversationVirtualStructure,
	classifyMeasuredConversationViewportFill,
	createRetainedConversationRangeExtractor,
	isConversationTargetLayoutReady,
	resolveConversationViewportRect,
	shouldPreserveConversationVirtualEdge,
} from './conversation-feed-viewport-geometry.js';
import type { ConversationVirtualFeedModel } from './conversation-feed-virtual-items.js';
import type { ConversationFeedRetentionState } from './ConversationFeedRetentionState.svelte.js';

export const CHAT_VIRTUAL_OVERSCAN = 6;
const CHAT_FALLBACK_VIEWPORT_HEIGHT = 720;
const MAX_SETTLE_ITERATIONS = 8;
const MAX_TARGET_SETTLE_ITERATIONS = 180;
const OFFSET_TOLERANCE_PX = 0.5;
const HIDDEN_ANCHOR_FALLBACK_RADIUS = 8;

interface ConversationVirtualAnchor {
	key: string;
	offsetWithinItem: number;
	fallbackKeys: readonly string[];
}

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

function nextAnimationFrame(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
		else queueMicrotask(resolve);
	});
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
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
	#layoutMutationToken = 0;
	#targetToken = 0;
	#hiddenAnchor: ConversationVirtualAnchor | null = null;
	#hiddenScrollOffset: number | null = null;
	#pendingReadingAnchor: ConversationVirtualAnchor | null = null;
	#measureOnShow = false;
	#pendingEndScroll = false;
	#programmaticScrollActive = false;
	#programmaticScrollEpoch = 0;
	#activeTargetScrolls = 0;
	#userIntentEpoch = 0;
	#scrollMargin = 0;
	#lastViewportRect: Rect = { width: 0, height: CHAT_FALLBACK_VIEWPORT_HEIGHT };
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
		$effect(() => this.#publishGeometry(options.geometry));
		$effect(() => this.#publishRetention(options.retention.retainedKeys));
		$effect(() => this.#publishPinned(options.pinned));
		$effect(() => this.#publishVisibility());
		$effect(() => this.#observeRootOffset());
	}

	measureItem: Attachment<HTMLDivElement> = (element) => {
		this.#instance().measureElement(element);
		return () => this.#instance().measureElement(null);
	};

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#virtualScrollElement = null;
		this.#instance().setOptions({
			getScrollElement: this.#getScrollElement,
			useCachedMeasurements: true,
		});
		this.#unsubscribe();
	}

	prepareForHide(): void {
		if (this.#destroyed || !this.#configuredVisible) return;
		if (!this.options.pinned) {
			this.#hiddenAnchor = this.#captureVirtualAnchor();
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
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		this.#instance().scrollToOffset(0, { behavior: 'auto' });
		void this.#completeSimpleScroll(operationEpoch, this.#layoutMutationToken);
	}

	scrollToEnd(options: { behavior?: 'auto' | 'instant' } = {}): void {
		if (!this.isReady()) {
			this.#pendingEndScroll = true;
			return;
		}
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		if (this.#measureOnShow) {
			this.#instance().measure();
			this.#measureOnShow = false;
		}
		this.#hiddenAnchor = null;
		this.#pendingEndScroll = false;
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		this.#instance().scrollToEnd({ behavior: options.behavior ?? 'auto' });
		void this.#completeEndRestore(this.#layoutMutationToken, operationEpoch);
	}

	restoreInitialEnd(): void {
		if (!this.isReady()) {
			this.#pendingEndScroll = true;
			return;
		}
		this.#cancelTargetScroll();
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		void this.#restoreInitialEndAfterCommit(operationEpoch);
	}

	scrollBy(delta: number): void {
		if (!this.isReady()) return;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		this.#instance().scrollBy(delta, { behavior: 'auto' });
		void this.#completeSimpleScroll(operationEpoch, this.#layoutMutationToken);
	}

	async waitForLayout(
		options: { targetKey?: string; minimumDataRevision?: number } = {},
	): Promise<ConversationLayoutWaitResult> {
		if (!this.isReady()) return 'not-ready';
		const token = this.#layoutMutationToken;
		let previousOffset: number | null = null;
		for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
			await tick();
			await nextAnimationFrame();
			if (token !== this.#layoutMutationToken) return 'superseded';
			const viewport = this.options.viewport;
			if (!viewport || !this.options.visible) return 'not-ready';
			const currentOffset = viewport.scrollTop;
			const dataReady =
				options.minimumDataRevision === undefined ||
				this.#appliedDataRevision >= options.minimumDataRevision;
			const targetReady = options.targetKey ? this.#isKeyMeasured(options.targetKey) : true;
			const stable =
				previousOffset !== null && Math.abs(currentOffset - previousOffset) <= OFFSET_TOLERANCE_PX;
			if (dataReady && targetReady && stable) return 'settled';
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
		const readingAnchor = restoreEnd ? null : this.#captureVirtualAnchor();
		const operationEpoch = this.#beginProgrammaticScrollOperation();

		try {
			for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
				await tick();
				await nextAnimationFrame();
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
					leadingSize: this.#scrollMargin,
					viewportHeight: viewport.clientHeight,
				});
				if (classification) {
					if (restoreEnd) instance.scrollToEnd({ behavior: 'auto' });
					else if (
						readingAnchor &&
						!(await this.#restoreVirtualAnchor(readingAnchor, false, false))
					) {
						return 'unsettled';
					}
					return classification;
				}
				const nextUnmeasuredIndex = keys.findIndex((key) => !instance.itemSizeCache.has(key));
				if (nextUnmeasuredIndex < 0) return 'unsettled';
				instance.scrollToIndex(nextUnmeasuredIndex, { align: 'start', behavior: 'auto' });
			}
			if (
				restoreEnd &&
				this.#isCurrentProgrammaticScrollOperation(operationEpoch) &&
				this.isReady()
			) {
				this.#instance().scrollToEnd({ behavior: 'auto' });
			} else if (readingAnchor) await this.#restoreVirtualAnchor(readingAnchor, false, false);
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
		const clearMeasurements = this.#measureOnShow;
		const userIntentEpoch = this.#userIntentEpoch;
		this.#measureOnShow = false;
		if (!anchor) {
			if (clearMeasurements) this.#instance().measure();
			if (scrollOffset !== null) {
				this.#instance().scrollToOffset(scrollOffset, { behavior: 'auto' });
				return 'restored';
			}
			return 'missing-anchor';
		}
		if (await this.#restoreVirtualAnchor(anchor, clearMeasurements, false)) return 'restored';
		if (!this.isReady() || scrollOffset === null || userIntentEpoch !== this.#userIntentEpoch) {
			return 'missing-anchor';
		}
		this.#instance().scrollToOffset(scrollOffset, { behavior: 'auto' });
		return 'restored';
	}

	cancelPendingLayoutMutation(): void {
		this.#layoutMutationToken += 1;
		this.#pendingReadingAnchor = null;
		this.#programmaticScrollActive = false;
		this.#programmaticScrollEpoch += 1;
	}

	cancelForUserIntent(): void {
		this.#userIntentEpoch += 1;
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
		this.#activeTargetScrolls += 1;
		try {
			this.#cancelTargetScroll();
			this.cancelPendingLayoutMutation();
			const token = this.#targetToken;
			await tick();
			await nextAnimationFrame();
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
				let previousRect: { top: number; height: number } | null = null;
				let stableFrames = 0;
				for (let attempt = 0; attempt < MAX_TARGET_SETTLE_ITERATIONS; attempt += 1) {
					await tick();
					await nextAnimationFrame();
					if (
						token !== this.#targetToken ||
						!this.#isCurrentProgrammaticScrollOperation(operationEpoch)
					) {
						return 'cancelled';
					}
					if (!this.isReady()) return 'not-ready';
					const node = this.#findTargetNode(resolved.innerRowId);
					if (!node) continue;
					if (!isConversationTargetLayoutReady(node)) {
						previousRect = null;
						stableFrames = 0;
						continue;
					}
					const viewport = this.options.viewport;
					if (!viewport) return 'not-ready';
					const attainableOffset = attainableConversationTargetOffset({
						currentOffset: viewport.scrollTop,
						alignmentDelta: this.#targetAlignmentDelta(node, options.align ?? 'center'),
						maximumOffset: Math.max(viewport.scrollHeight - viewport.clientHeight, 0),
					});
					const offsetDelta = attainableOffset - viewport.scrollTop;
					if (Math.abs(offsetDelta) > CHAT_GEOMETRY_END_THRESHOLD_PX) {
						this.#instance().scrollToOffset(attainableOffset, { behavior: 'auto' });
						previousRect = null;
						stableFrames = 0;
						continue;
					}
					const nodeRect = node.getBoundingClientRect();
					const viewportRect = viewport.getBoundingClientRect();
					const currentRect = { top: nodeRect.top - viewportRect.top, height: nodeRect.height };
					const stable =
						previousRect !== null &&
						Math.abs(currentRect.top - previousRect.top) <= OFFSET_TOLERANCE_PX &&
						Math.abs(currentRect.height - previousRect.height) <= OFFSET_TOLERANCE_PX;
					stableFrames = stable ? stableFrames + 1 : 0;
					previousRect = currentRect;
					if (stableFrames >= 2) return 'completed';
				}
				return 'not-ready';
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
		const model = this.options.model;
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
		const resetMeasurements =
			snapshot.measurementReset === 'all' || keys.length < this.#configuredKeys.length;
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
		const preservationAnchor = shouldCaptureReadingPosition
			? (this.#pendingReadingAnchor ?? this.#captureVirtualAnchor(preserveEdgeReadingPosition))
			: null;
		if (preservationAnchor && !restorePolicyEnd) {
			this.#pendingReadingAnchor = preservationAnchor;
		} else if (!shouldCaptureReadingPosition || restorePolicyEnd) {
			this.#pendingReadingAnchor = null;
		}

		if (identityChanged) this.#detachAndResetOldSurface();
		const indexByKey = new Map(keys.map((key, index) => [key, index] as const));
		this.options.retention.prune(indexByKey.keys());
		const retainedIndexes = this.options.retention.retainedKeys.flatMap((key) => {
			const index = indexByKey.get(key);
			return index === undefined ? [] : [index];
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
				void this.#resetMeasurementsAfterCommit(layoutToken, snapshot, false);
			}
			return;
		}

		if (resetMeasurements && preservationAnchor) {
			this.#scheduleReadingRestore(preservationAnchor, true, restorePolicyEnd);
		} else if (resetMeasurements) {
			void this.#resetMeasurementsAfterCommit(layoutToken, snapshot, restorePolicyEnd);
		} else if (restorePolicyEnd) {
			void this.#restorePolicyEndAfterCommit(layoutToken, snapshot);
		} else if (preservationAnchor) {
			this.#scheduleReadingRestore(preservationAnchor, false, false);
		}
	}

	#publishRetention(retainedKeys: readonly string[]): void {
		const indexByKey = new Map(this.#configuredKeys.map((key, index) => [key, index] as const));
		const retainedIndexes = retainedKeys.flatMap((key) => {
			const index = indexByKey.get(key);
			return index === undefined ? [] : [index];
		});
		if (arraysEqual(retainedIndexes, this.#configuredRetainedIndexes)) return;
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
		if (!visible && this.#configuredVisible && !this.options.pinned) {
			this.#hiddenAnchor = this.#captureVirtualAnchor();
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
		const update = (): void => {
			const next =
				root.getBoundingClientRect().top -
				viewport.getBoundingClientRect().top +
				viewport.scrollTop;
			if (Math.abs(next - this.#scrollMargin) <= OFFSET_TOLERANCE_PX) return;
			this.#scrollMargin = next;
			this.#instance().setOptions({ scrollMargin: next });
		};
		update();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(update);
		observer.observe(viewport);
		observer.observe(root);
		return () => observer.disconnect();
	}

	#detachAndResetOldSurface(): void {
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
		this.#instance().measure();
	}

	#captureVirtualAnchor(preferTranscript = false): ConversationVirtualAnchor | null {
		const instance = this.#instance();
		const offset = this.options.viewport?.scrollTop ?? instance.scrollOffset ?? 0;
		const itemAtOffset = instance.getVirtualItemForOffset(offset);
		// Prefix controls occupy offset zero, so history prepends preserve the nearest message instead.
		const item = preferTranscript
			? instance
					.getVirtualItems()
					.filter((candidate) => this.#configuredTranscriptKeys.has(String(candidate.key)))
					.sort((left, right) => {
						const distance = (candidate: typeof left): number =>
							offset < candidate.start
								? candidate.start - offset
								: offset > candidate.end
									? offset - candidate.end
									: 0;
						return distance(left) - distance(right);
					})[0]
			: itemAtOffset;
		if (!item || typeof item.key !== 'string') return null;
		const index = this.#configuredKeys.indexOf(item.key);
		const fallbackKeys: string[] = [];
		if (index >= 0) {
			for (let distance = 1; distance <= HIDDEN_ANCHOR_FALLBACK_RADIUS; distance += 1) {
				const before = this.#configuredKeys[index - distance];
				const after = this.#configuredKeys[index + distance];
				if (before) fallbackKeys.push(before);
				if (after) fallbackKeys.push(after);
			}
		}
		return { key: item.key, offsetWithinItem: offset - item.start, fallbackKeys };
	}

	async #restoreVirtualAnchor(
		anchor: ConversationVirtualAnchor,
		clearMeasurements: boolean,
		restoreEnd: boolean,
	): Promise<boolean> {
		const token = ++this.#layoutMutationToken;
		const model = this.options.model;
		const key = [anchor.key, ...anchor.fallbackKeys].find((candidate) =>
			model.indexByKey.has(candidate),
		);
		if (!key) return false;
		const release = this.options.retention.acquire(key, 'target');
		const operationEpoch = this.#beginProgrammaticScrollOperation();
		try {
			if (clearMeasurements) this.#instance().measure();
			if (restoreEnd) {
				await tick();
				if (
					token !== this.#layoutMutationToken ||
					!this.#isCurrentProgrammaticScrollOperation(operationEpoch) ||
					!this.isReady()
				) {
					return false;
				}
				this.#instance().scrollToEnd({ behavior: 'auto' });
				await this.#completeEndRestore(token, operationEpoch);
				return (
					token === this.#layoutMutationToken &&
					this.#isCurrentProgrammaticScrollOperation(operationEpoch)
				);
			}
			const index = model.indexByKey.get(key);
			if (index === undefined) return false;
			this.#instance().scrollToIndex(index, { align: 'start', behavior: 'auto' });
			for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
				await tick();
				await nextAnimationFrame();
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
				const offset = key === anchor.key ? anchor.offsetWithinItem : 0;
				this.#instance().scrollToOffset(item.start + offset, { behavior: 'auto' });
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
					Math.abs(settledOffset - (settledItem.start + offset)) <= OFFSET_TOLERANCE_PX
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

	#scheduleReadingRestore(
		anchor: ConversationVirtualAnchor,
		clearMeasurements: boolean,
		restoreEnd: boolean,
	): void {
		void this.#restoreVirtualAnchor(anchor, clearMeasurements, restoreEnd).then((restored) => {
			if (restored && this.#pendingReadingAnchor === anchor) {
				this.#pendingReadingAnchor = null;
			}
		});
	}

	async #restorePolicyEndAfterCommit(
		token: number,
		snapshot: ConversationVirtualGeometrySnapshot,
	): Promise<void> {
		await tick();
		await nextAnimationFrame();
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
		token: number,
		snapshot: ConversationVirtualGeometrySnapshot,
		restorePolicyEnd: boolean,
	): Promise<void> {
		await tick();
		await nextAnimationFrame();
		if (!this.isReady() || this.options.geometry.geometryRevision !== snapshot.geometryRevision) {
			return;
		}
		this.#instance().measure();
		if (
			restorePolicyEnd &&
			this.#activeTargetScrolls === 0 &&
			token === this.#layoutMutationToken &&
			this.options.pinned &&
			this.options.geometry.endBehavior === 'restore-if-pinned'
		) {
			this.scrollToEnd();
		}
	}

	async #completeEndRestore(token: number, operationEpoch: number): Promise<void> {
		try {
			for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
				await tick();
				await nextAnimationFrame();
				if (
					token !== this.#layoutMutationToken ||
					!this.#isCurrentProgrammaticScrollOperation(operationEpoch) ||
					!this.isReady()
				) {
					return;
				}
				if (this.isAtEnd()) {
					this.options.onInitialEndRestored?.();
					return;
				}
				this.#instance().scrollToEnd({ behavior: 'auto' });
			}
			if (
				token !== this.#layoutMutationToken ||
				!this.#isCurrentProgrammaticScrollOperation(operationEpoch) ||
				!this.isReady()
			) {
				return;
			}
			this.#instance().scrollToEnd({ behavior: 'auto' });
			this.options.onInitialEndRestored?.();
		} finally {
			this.#finishProgrammaticScrollOperation(operationEpoch);
		}
	}

	async #restoreInitialEndAfterCommit(operationEpoch: number): Promise<void> {
		await tick();
		await nextAnimationFrame();
		if (operationEpoch !== this.#programmaticScrollEpoch || !this.isReady()) {
			this.#finishProgrammaticScrollOperation(operationEpoch);
			return;
		}
		this.#instance().scrollToEnd({ behavior: 'auto' });
		await this.#completeEndRestore(this.#layoutMutationToken, operationEpoch);
	}

	async #completeSimpleScroll(operationEpoch: number, token: number): Promise<void> {
		let previousOffset: number | null = null;
		for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
			await tick();
			await nextAnimationFrame();
			if (
				token !== this.#layoutMutationToken ||
				!this.#isCurrentProgrammaticScrollOperation(operationEpoch) ||
				!this.isReady()
			) {
				break;
			}
			const viewport = this.options.viewport;
			if (!viewport) break;
			if (
				previousOffset !== null &&
				Math.abs(previousOffset - viewport.scrollTop) <= OFFSET_TOLERANCE_PX
			) {
				break;
			}
			previousOffset = viewport.scrollTop;
		}
		this.#finishProgrammaticScrollOperation(operationEpoch);
	}

	#isKeyMeasured(key: string): boolean {
		return (
			this.#instance().itemSizeCache.has(key) &&
			this.#instance()
				.getVirtualItems()
				.some((item) => item.key === key)
		);
	}

	#findTargetNode(rowId: string): HTMLElement | null {
		const root = this.options.virtualRoot;
		if (!root) return null;
		const candidates = root.querySelectorAll<HTMLElement>(
			'[data-chat-row-id], [data-chat-anchor-id]',
		);
		for (const candidate of candidates) {
			if (candidate.dataset.chatRowId === rowId || candidate.dataset.chatAnchorId === rowId) {
				return candidate;
			}
		}
		return null;
	}

	#targetAlignmentDelta(node: HTMLElement, align: 'center' | 'start' | 'end'): number {
		const viewport = this.options.viewport;
		if (!viewport) return 0;
		const viewportRect = viewport.getBoundingClientRect();
		const nodeRect = node.getBoundingClientRect();
		if (align === 'start') return nodeRect.top - viewportRect.top;
		if (align === 'end') return nodeRect.bottom - viewportRect.bottom;
		return nodeRect.top + nodeRect.height / 2 - (viewportRect.top + viewportRect.height / 2);
	}

	#beginProgrammaticScrollOperation(): number {
		this.#programmaticScrollActive = true;
		return ++this.#programmaticScrollEpoch;
	}

	#isCurrentProgrammaticScrollOperation(epoch: number): boolean {
		return epoch === this.#programmaticScrollEpoch;
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

	#observeElementRect = (
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (rect: Rect) => void,
	): (() => void) => {
		const cleanup = observeElementRect(instance, (rect) => {
			this.#lastViewportRect = resolveConversationViewportRect(this.#lastViewportRect, rect);
			callback(this.#lastViewportRect);
		});
		return cleanup ?? (() => {});
	};

	#instance(): SvelteVirtualizer<HTMLElement, HTMLDivElement> {
		return this.#instanceValue;
	}
}
