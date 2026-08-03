import { tick, untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Readable, Unsubscriber } from 'svelte/store';
import {
	createVirtualizer,
	defaultRangeExtractor,
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
import type { ConversationVirtualFeedModel } from './conversation-feed-virtual-items.js';
import type { ConversationFeedRetentionState } from './ConversationFeedRetentionState.svelte.js';

export const CHAT_VIRTUAL_OVERSCAN = 6;
export const CHAT_GEOMETRY_END_THRESHOLD_PX = 1;
const CHAT_FALLBACK_VIEWPORT_HEIGHT = 720;
const MAX_SETTLE_ITERATIONS = 8;
const MAX_TARGET_SETTLE_ITERATIONS = 60;
const OFFSET_TOLERANCE_PX = 0.5;
const HIDDEN_ANCHOR_FALLBACK_RADIUS = 8;

interface ConversationVirtualAnchor {
	key: string;
	offsetWithinItem: number;
	fallbackKeys: readonly string[];
}

export type ConversationVirtualStructureChange =
	'none' | 'identity' | 'edge-qualified' | 'interior-only';

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

export function classifyConversationVirtualStructure(input: {
	identityChanged: boolean;
	previousKeys: readonly string[];
	previousEstimates: readonly number[];
	nextKeys: readonly string[];
	nextEstimates: readonly number[];
}): ConversationVirtualStructureChange {
	if (input.identityChanged) return 'identity';
	const keysChanged = !arraysEqual(input.previousKeys, input.nextKeys);
	const estimatesChanged = !arraysEqual(input.previousEstimates, input.nextEstimates);
	if (!keysChanged && !estimatesChanged) return 'none';
	if (
		input.previousKeys.length !== input.nextKeys.length ||
		input.previousKeys[0] !== input.nextKeys[0] ||
		input.previousKeys.at(-1) !== input.nextKeys.at(-1)
	) {
		return 'edge-qualified';
	}
	return 'interior-only';
}

export function shouldPreserveConversationVirtualEdge(input: {
	structure: ConversationVirtualStructureChange;
	endBehavior: ConversationVirtualGeometrySnapshot['endBehavior'];
	restorePolicyEnd: boolean;
}): boolean {
	return (
		input.structure === 'edge-qualified' &&
		input.endBehavior !== 'explicit-navigation' &&
		!input.restorePolicyEnd
	);
}

export function retainedConversationRange(
	range: Range,
	retainedIndexes: readonly number[],
): number[] {
	const indexes = new Set(defaultRangeExtractor(range));
	for (const index of retainedIndexes) {
		if (index >= 0 && index < range.count) indexes.add(index);
	}
	return [...indexes].sort((left, right) => left - right);
}

export function classifyMeasuredConversationViewportFill(input: {
	keys: readonly string[];
	measuredSizes: { get(key: string): number | undefined };
	leadingSize: number;
	viewportHeight: number;
}): 'overflow' | 'underfilled' | null {
	let physicalSize = input.leadingSize;
	for (const key of input.keys) {
		const size = input.measuredSizes.get(key);
		if (size === undefined) return null;
		physicalSize += size;
		if (physicalSize > input.viewportHeight + CHAT_GEOMETRY_END_THRESHOLD_PX) {
			return 'overflow';
		}
	}
	return 'underfilled';
}

export function attainableConversationTargetOffset(input: {
	currentOffset: number;
	alignmentDelta: number;
	maximumOffset: number;
}): number {
	return Math.max(0, Math.min(input.maximumOffset, input.currentOffset + input.alignmentDelta));
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
	#userIntentEpoch = 0;
	#scrollMargin = 0;
	#lastViewportRect: Rect = { width: 0, height: CHAT_FALLBACK_VIEWPORT_HEIGHT };
	#destroyed = false;

	constructor(private readonly options: ConversationFeedVirtualControllerOptions) {
		const geometry = untrack(() => options.geometry);
		this.#configuredGeometryRevision = geometry.geometryRevision;
		this.#configuredSurfaceIdentity = geometry.surfaceIdentity;
		this.#configuredKeys = geometry.keys;
		this.#configuredEstimates = geometry.estimates;
		this.#configuredTranscriptKeys = new Set(
			untrack(() => options.model).items.flatMap((item) =>
				item.kind === 'transcript' ? [item.key] : [],
			),
		);
		this.#appliedDataRevision = untrack(() => options.projectedDataRevision);
		this.#configuredVisible = untrack(() => options.visible);
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
		});
		this.#unsubscribe = this.virtualizer.subscribe((instance) => {
			this.#instanceValue = instance;
		});

		$effect(() => this.#acknowledgeData(options.projectedDataRevision));
		$effect(() => this.#publishGeometry(options.geometry));
		$effect(() => this.#publishRetention(options.retention.retainedKeys));
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
				if (token !== this.#layoutMutationToken || !this.isReady()) return 'unsettled';
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
			if (restoreEnd && this.isReady()) this.#instance().scrollToEnd({ behavior: 'auto' });
			else if (readingAnchor) await this.#restoreVirtualAnchor(readingAnchor, false, false);
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
				if (token !== this.#targetToken) return 'cancelled';
				if (!this.isReady()) return 'not-ready';
				const node = this.#findTargetNode(resolved.innerRowId);
				if (!node) continue;
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
	}

	#acknowledgeData(projectedDataRevision: number): void {
		this.#appliedDataRevision = Math.max(this.#appliedDataRevision, projectedDataRevision);
	}

	#publishGeometry(snapshot: ConversationVirtualGeometrySnapshot): void {
		if (snapshot.geometryRevision === this.#configuredGeometryRevision) return;
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
			rangeExtractor: (range) => retainedConversationRange(range, retainedIndexes),
		});
		instance.getVirtualItems();

		this.#configuredGeometryRevision = snapshot.geometryRevision;
		this.#configuredSurfaceIdentity = snapshot.surfaceIdentity;
		this.#configuredKeys = keys;
		this.#configuredEstimates = estimates;
		this.#configuredTranscriptKeys = new Set(
			this.options.model.items.flatMap((item) => (item.kind === 'transcript' ? [item.key] : [])),
		);
		this.#configuredRetainedIndexes = retainedIndexes;
		if (identityChanged) this.#publishVisibility(true);
		const layoutToken = ++this.#layoutMutationToken;
		if (!this.options.visible) {
			if (resetMeasurements) this.#measureOnShow = true;
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
			rangeExtractor: (range) => retainedConversationRange(range, retainedIndexes),
		});
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
				if (token !== this.#layoutMutationToken || !this.isReady()) return false;
				this.#instance().scrollToEnd({ behavior: 'auto' });
				await this.#completeEndRestore(token, operationEpoch);
				return token === this.#layoutMutationToken;
			}
			const index = model.indexByKey.get(key);
			if (index === undefined) return false;
			this.#instance().scrollToIndex(index, { align: 'start', behavior: 'auto' });
			for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
				await tick();
				await nextAnimationFrame();
				if (token !== this.#layoutMutationToken || !this.isReady()) return false;
				const item = this.#instance()
					.getVirtualItems()
					.find((candidate) => candidate.key === key);
				if (!item) continue;
				const offset = key === anchor.key ? anchor.offsetWithinItem : 0;
				this.#instance().scrollToOffset(item.start + offset, { behavior: 'auto' });
				await nextAnimationFrame();
				if (token !== this.#layoutMutationToken || !this.isReady()) return false;
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
				if (token !== this.#layoutMutationToken || !this.isReady()) return;
				if (this.isAtEnd()) {
					this.options.onInitialEndRestored?.();
					return;
				}
				this.#instance().scrollToEnd({ behavior: 'auto' });
			}
			if (token !== this.#layoutMutationToken || !this.isReady()) return;
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
			if (token !== this.#layoutMutationToken || !this.isReady()) break;
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

	#finishProgrammaticScrollOperation(epoch: number): void {
		if (epoch !== this.#programmaticScrollEpoch) return;
		this.#programmaticScrollActive = false;
	}

	#cancelTargetScroll(): void {
		this.#targetToken += 1;
	}

	#getScrollElement = (): HTMLDivElement | null => this.#virtualScrollElement;

	#observeElementRect = (
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (rect: Rect) => void,
	): (() => void) => {
		const cleanup = observeElementRect(instance, (rect) => {
			if (rect.height > 0 && rect.width > 0) this.#lastViewportRect = rect;
			callback(this.#lastViewportRect);
		});
		return cleanup ?? (() => {});
	};

	#instance(): SvelteVirtualizer<HTMLElement, HTMLDivElement> {
		return this.#instanceValue;
	}
}
