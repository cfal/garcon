import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { ConversationNativeScrollActivity } from '$lib/chat/transcript/conversation-native-scroll-settlement.js';
import type {
	ConversationLayoutWaitResult,
	ConversationViewportFillResult,
	ConversationViewportIntentCancellationResult,
	ConversationViewportPort,
	ConversationViewportTarget,
	ConversationViewportTargetResult,
	HiddenReadingRestoreResult,
} from '$lib/chat/transcript/conversation-viewport-port.js';
import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import type {
	VirtualListSnapshot,
	VirtualMutationAnchor,
	VirtualResumeTarget,
	VirtualTransactionRecord,
} from '$lib/virt/virtual-list-types.js';
import type {
	ConversationFeedProjection,
	ConversationVirtualGeometrySnapshot,
} from './ConversationFeedProjectionState.svelte.js';
import type { ConversationFeedRetentionState } from './ConversationFeedRetentionState.svelte.js';
import {
	CHAT_GEOMETRY_END_THRESHOLD_PX,
	CHAT_VIRTUAL_FOLLOWING_BUFFER_ROWS,
	classifyConversationVirtualStructure,
	retainedConversationRange,
	shouldPreserveConversationVirtualEdge,
} from './conversation-feed-viewport-geometry.js';
import {
	captureConversationVirtualAnchor,
	type ConversationVirtualAnchor,
	ConversationEarlierPrependAnchorOwnership,
	ConversationMountedVirtualItems,
	measureConversationViewportFill,
	nextConversationLayoutFrame,
	settleConversationEndRestore,
	settleConversationTarget,
} from './conversation-feed-virtual-runtime.js';
import type { ConversationVirtualFeedModel } from './conversation-feed-virtual-items.js';

export const CHAT_VIRTUAL_OVERSCAN = 6;
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
	onTransaction?(record: VirtualTransactionRecord): void;
}

interface ConversationProjectionApplication {
	readonly previous: ConversationFeedProjection;
	readonly next: ConversationFeedProjection;
	readonly pinned: boolean;
	readonly scrollbarDragActive: boolean;
}

export class ConversationFeedVirtualController implements ConversationViewportPort {
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;

	#virt: VirtualListController;
	#configuredGeometry: ConversationVirtualGeometrySnapshot;
	#configuredModel: ConversationVirtualFeedModel;
	#configuredTranscriptKeys: ReadonlySet<string>;
	#configuredVisible: boolean;
	#configuredPinned: boolean;
	#appliedDataRevision: number;
	#layoutMutationToken = 0;
	#targetToken = 0;
	#endRestoreEpoch = 0;
	#activeTargetScrolls = 0;
	#hiddenAnchor: ConversationVirtualAnchor | null = null;
	#hiddenResumeResult: HiddenReadingRestoreResult | null = null;
	#pendingEndScroll = false;
	#measureOnShow = false;
	#earlierPrependAnchor = new ConversationEarlierPrependAnchorOwnership();
	#mountedItems = new ConversationMountedVirtualItems();
	#itemAttachments = new Map<string, Attachment<HTMLElement>>();
	#destroyed = false;

	constructor(private readonly options: ConversationFeedVirtualControllerOptions) {
		this.#configuredGeometry = untrack(() => options.geometry);
		this.#configuredModel = untrack(() => options.model);
		this.#configuredTranscriptKeys = transcriptKeys(this.#configuredModel);
		this.#configuredVisible = untrack(() => options.visible);
		this.#configuredPinned = untrack(() => options.pinned);
		this.#appliedDataRevision = untrack(() => options.projectedDataRevision);
		const measurementAnchor = () => this.#measurementAnchor();
		this.#virt = new VirtualListController({
			get overscan() {
				return CHAT_VIRTUAL_OVERSCAN;
			},
			get measurementAnchor() {
				return measurementAnchor();
			},
			onTransaction: options.onTransaction,
		});
		this.viewport = this.#virt.viewport;
		this.sizer = this.#virt.sizer;
		this.#virt.apply({
			kind: 'update',
			keys: this.#configuredGeometry.keys,
			estimates: this.#configuredGeometry.estimates,
			anchor: { kind: 'none' },
		});
		if (!this.#configuredVisible) this.#virt.suspend();
		$effect(() => this.#acknowledgeData(options.projectedDataRevision));
		$effect(() => this.#publishPinned(options.pinned));
		$effect(() => this.#publishVisibility(options.visible));
		$effect(() => {
			void options.viewport;
			void options.virtualRoot;
			this.#virt.refreshLayout();
		});
	}

	get snapshot(): VirtualListSnapshot {
		return this.#virt.snapshot;
	}

	item(key: string): Attachment<HTMLElement> {
		let attachment = this.#itemAttachments.get(key);
		if (attachment) return attachment;
		const virtualAttachment = this.#virt.item(key);
		attachment = (element) => {
			this.#mountedItems.add(element as HTMLDivElement);
			if (this.#configuredTranscriptKeys.has(key)) this.#earlierPrependAnchor.retainMountedRow(key);
			const cleanup = virtualAttachment(element);
			return () => {
				this.#mountedItems.delete(element as HTMLDivElement);
				cleanup?.();
			};
		};
		this.#itemAttachments.set(key, attachment);
		return attachment;
	}

	renderedIndexes(snapshot: VirtualListSnapshot): readonly number[] {
		const retainedIndexes = this.options.retention.retainedKeys.flatMap((key) => {
			const index = this.#configuredModel.indexByKey.get(key);
			return index === undefined ? [] : [index];
		});
		const retained = this.#earlierPrependAnchor.retainedIndexes(
			retainedIndexes,
			this.#configuredModel.indexByKey,
		);
		const trailingStart = this.options.pinned
			? Math.max(
					this.#configuredModel.transcriptStartIndex,
					this.#configuredModel.transcriptEndIndex - 1,
				)
			: null;
		return retainedConversationRange(
			snapshot.overscanRange,
			snapshot.positions.count,
			retained,
			trailingStart,
			CHAT_VIRTUAL_FOLLOWING_BUFFER_ROWS,
		);
	}

	applyProjection(input: ConversationProjectionApplication): boolean {
		const nextGeometry = input.next.geometry;
		if (nextGeometry.geometryRevision === this.#configuredGeometry.geometryRevision) {
			this.#configuredModel = input.next.model;
			this.#appliedDataRevision = Math.max(
				this.#appliedDataRevision,
				input.next.projectedDataRevision,
			);
			return true;
		}
		const identityChanged =
			nextGeometry.surfaceIdentity !== this.#configuredGeometry.surfaceIdentity;
		const structure = classifyConversationVirtualStructure({
			identityChanged,
			previousKeys: this.#configuredGeometry.keys,
			previousEstimates: this.#configuredGeometry.estimates,
			nextKeys: nextGeometry.keys,
			nextEstimates: nextGeometry.estimates,
		});
		const restoreEnd = nextGeometry.endBehavior === 'restore-if-pinned' && input.pinned;
		const preferTranscript =
			nextGeometry.measurementReset === 'all' ||
			shouldPreserveConversationVirtualEdge({
				structure,
				endBehavior: nextGeometry.endBehavior,
				restorePolicyEnd: restoreEnd,
			});
		const readingAnchor = identityChanged ? null : this.#captureVirtualAnchor(preferTranscript);
		if (nextGeometry.mutationKinds.has('history-earlier')) {
			const position = this.viewportPosition();
			this.#earlierPrependAnchor.beginMountedRowRetention(
				this.#mountedItems.transcriptKeys(
					this.#configuredGeometry.keys,
					this.#configuredTranscriptKeys,
				),
				Boolean(
					position &&
					(!position.leadingContentReachable ||
						position.distanceFromStart <= CHAT_GEOMETRY_END_THRESHOLD_PX),
				),
				input.scrollbarDragActive,
			);
		}
		const selectedAnchor = this.#resolveAnchor(readingAnchor, input.next.model);
		const anchor: VirtualMutationAnchor =
			this.#activeTargetScrolls > 0 || nextGeometry.endBehavior === 'explicit-navigation'
				? { kind: 'none' }
				: restoreEnd
					? { kind: 'end' }
					: selectedAnchor
						? { kind: 'item', key: selectedAnchor.key }
						: { kind: 'none' };
		const result = this.#virt.apply(
			identityChanged
				? {
						kind: 'replace-surface',
						keys: nextGeometry.keys,
						estimates: nextGeometry.estimates,
					}
				: {
						kind: nextGeometry.measurementReset === 'all' ? 'reset-measurements' : 'update',
						keys: nextGeometry.keys,
						estimates: nextGeometry.estimates,
						anchor,
					},
		);
		if (result.kind === 'rejected') return false;

		this.#configuredGeometry = nextGeometry;
		this.#configuredModel = input.next.model;
		this.#configuredTranscriptKeys = transcriptKeys(input.next.model);
		this.#configuredPinned = input.pinned;
		this.#appliedDataRevision = Math.max(
			this.#appliedDataRevision,
			input.next.projectedDataRevision,
		);
		this.options.retention.prune(nextGeometry.keys);
		this.#pruneItemAttachments();
		this.#earlierPrependAnchor.carry(
			selectedAnchor,
			nextGeometry.mutationKinds.has('history-earlier'),
		);
		this.#layoutMutationToken += 1;
		if (identityChanged) {
			this.options.retention.clear();
			this.#mountedItems.clear();
			this.#itemAttachments.clear();
			this.#hiddenAnchor = null;
			this.#hiddenResumeResult = null;
			this.#measureOnShow = false;
			this.#pendingEndScroll = restoreEnd;
			if (this.options.visible)
				this.#resumeCurrentSurface(restoreEnd ? { kind: 'end' } : { kind: 'start' });
		} else if (!this.options.visible && nextGeometry.measurementReset === 'all') {
			this.#measureOnShow = true;
		}
		return true;
	}

	prepareForHide(): void {
		if (this.#destroyed || !this.#configuredVisible) return;
		this.#hiddenAnchor = this.options.pinned ? null : this.#captureVirtualAnchor(true);
		this.#hiddenResumeResult = null;
		this.#configuredVisible = false;
		this.#endRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#virt.suspend();
	}

	finishScrollbarDrag(): void {
		this.#earlierPrependAnchor.finishScrollbarDrag();
	}

	isReady(): boolean {
		return !this.#destroyed && this.options.visible && this.#virt.viewportPosition !== null;
	}

	isAtEnd(threshold = CHAT_GEOMETRY_END_THRESHOLD_PX): boolean {
		const viewport = this.options.viewport;
		return Boolean(
			this.isReady() &&
			viewport &&
			viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= threshold,
		);
	}

	ownsScrollPosition(): boolean {
		return this.#virt.ownsScrollPosition;
	}

	viewportPosition() {
		const position = this.#virt.viewportPosition;
		return position
			? {
					logicalOffset: position.logicalOffset,
					distanceFromStart: position.distanceFromStart,
					leadingContentReachable: position.leadingContentReachable,
				}
			: null;
	}

	scrollToStart(): void {
		if (!this.isReady()) return;
		this.#endRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#virt.scrollToStart();
	}

	scrollToEnd(): void {
		if (this.#destroyed) return;
		if (!this.isReady()) {
			this.#pendingEndScroll = true;
			return;
		}
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#hiddenAnchor = null;
		this.#pendingEndScroll = false;
		this.#virt.scrollToEnd();
		this.#settleEndRestore();
	}

	restoreInitialEnd(): void {
		this.scrollToEnd();
	}

	scrollBy(delta: number): void {
		if (!this.isReady()) return;
		this.#endRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#virt.scrollBy(delta);
	}

	async waitForLayout(
		options: { minimumDataRevision?: number } = {},
	): Promise<ConversationLayoutWaitResult> {
		if (!this.isReady()) return 'not-ready';
		const token = this.#layoutMutationToken;
		let previous: { offset: number; revision: number } | null = null;
		for (let attempt = 0; attempt < MAX_SETTLE_ITERATIONS; attempt += 1) {
			await nextConversationLayoutFrame();
			if (token !== this.#layoutMutationToken) return 'superseded';
			const position = this.#virt.viewportPosition;
			if (!position || !this.options.visible) return 'not-ready';
			const revision = this.#virt.snapshot.revision;
			const dataReady =
				options.minimumDataRevision === undefined ||
				this.#appliedDataRevision >= options.minimumDataRevision;
			const stable =
				previous !== null &&
				previous.revision === revision &&
				Math.abs(previous.offset - position.logicalOffset) <= OFFSET_TOLERANCE_PX;
			if (dataReady && stable) return 'settled';
			previous = { offset: position.logicalOffset, revision };
		}
		return 'not-ready';
	}

	async measureViewportFill(): Promise<ConversationViewportFillResult> {
		if (!this.isReady()) return 'unsettled';
		const keys = this.#configuredGeometry.keys;
		if (keys.length === 0) return 'underfilled';
		const restoreEnd = this.options.pinned;
		const readingAnchor = restoreEnd ? null : this.#captureVirtualAnchor(true);
		const token = this.#layoutMutationToken;
		return measureConversationViewportFill({
			keys,
			measuredSize: (key) => this.#virt.measuredSize(key),
			viewport: () => this.options.viewport,
			isCurrent: () => token === this.#layoutMutationToken && this.isReady(),
			restoreEnd,
			readingAnchor,
			restoreReadingAnchor: (anchor) => this.#restoreVirtualAnchor(anchor),
			scrollToIndex: (index) => {
				this.#virt.scrollToIndex(index, { align: 'start' });
			},
			scrollToEnd: () => {
				this.#virt.scrollToEnd();
			},
		});
	}

	async restoreHiddenReadingPosition(): Promise<HiddenReadingRestoreResult> {
		if (!this.options.visible) return 'not-ready';
		if (!this.#configuredVisible) this.#publishVisibility(true);
		const result = this.#hiddenResumeResult;
		this.#hiddenResumeResult = null;
		if (result) return result;
		return this.isReady() ? 'restored' : 'not-ready';
	}

	cancelPendingLayoutMutation(): void {
		this.#layoutMutationToken += 1;
		this.#earlierPrependAnchor.clear();
		this.#virt.cancelOwnedScroll();
	}

	cancelForUserIntent(
		direction: 'earlier' | 'later' | null,
		source: 'viewport' | 'scrollbar-drag' = 'viewport',
	): ConversationViewportIntentCancellationResult {
		this.#endRestoreEpoch += 1;
		this.#cancelTargetScroll();
		const preservesEarlierPrepend = this.#earlierPrependAnchor.preserves(
			direction,
			this.viewportPosition(),
			source,
		);
		this.#virt.cancelOwnedScroll();
		if (preservesEarlierPrepend) {
			this.options.onInitialEndRestored?.();
			return this.#earlierPrependAnchor.blocksViewportMutation(source)
				? 'blocked-scrollbar-drag'
				: 'preserved-earlier-prepend';
		}
		this.cancelPendingLayoutMutation();
		this.options.onInitialEndRestored?.();
		return 'cancelled';
	}

	setNativeScrollActivity(activity: ConversationNativeScrollActivity): void {
		this.#virt.setScrollActivity(activity);
	}

	refreshLayout(): void {
		this.#virt.refreshLayout();
	}

	async scrollToTarget(
		target: ConversationViewportTarget,
		options: { align?: 'center' | 'start' | 'end' } = {},
	): Promise<ConversationViewportTargetResult> {
		if (!this.isReady()) return 'not-ready';
		this.#endRestoreEpoch += 1;
		this.#activeTargetScrolls += 1;
		const token = ++this.#targetToken;
		try {
			this.cancelPendingLayoutMutation();
			await nextConversationLayoutFrame();
			if (token !== this.#targetToken) return 'cancelled';
			if (!this.isReady()) return 'not-ready';
			const model = this.#configuredModel;
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
			const releaseTarget = this.options.retention.acquire(key, 'target');
			try {
				this.#virt.scrollToIndex(resolved.index, { align: options.align ?? 'center' });
				return await settleConversationTarget({
					root: () => this.options.virtualRoot,
					rowId: resolved.innerRowId,
					viewport: () => this.options.viewport,
					align: options.align ?? 'center',
					isCurrent: () => token === this.#targetToken,
					isReady: () => this.isReady(),
					scrollBy: (delta) => {
						this.#virt.scrollBy(delta);
					},
					onSettledNode: (node) => {
						const wrapper = node.closest<HTMLElement>('[data-chat-virtual-item]');
						if (wrapper) this.#virt.remeasure(wrapper);
					},
				});
			} finally {
				releaseTarget();
			}
		} finally {
			this.#activeTargetScrolls -= 1;
		}
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#endRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.#earlierPrependAnchor.clear();
		this.#mountedItems.clear();
		this.#itemAttachments.clear();
		this.#virt.destroy();
	}

	#captureVirtualAnchor(preferTranscript: boolean): ConversationVirtualAnchor | null {
		return captureConversationVirtualAnchor({
			snapshot: this.#virt.snapshot,
			position: this.#virt.viewportPosition,
			keys: this.#configuredGeometry.keys,
			transcriptKeys: this.#configuredTranscriptKeys,
			preferTranscript,
		});
	}

	#resolveAnchor(
		anchor: ConversationVirtualAnchor | null,
		model: ConversationVirtualFeedModel,
	): ConversationVirtualAnchor | null {
		if (!anchor) return null;
		const key = [anchor.key, ...anchor.fallbackKeys].find((candidate) =>
			model.indexByKey.has(candidate),
		);
		return key
			? { key, viewportOffset: key === anchor.key ? anchor.viewportOffset : 0, fallbackKeys: [] }
			: null;
	}

	#restoreVirtualAnchor(anchor: ConversationVirtualAnchor): boolean {
		const resolved = this.#resolveAnchor(anchor, this.#configuredModel);
		if (!resolved) return false;
		return this.#virt.scrollToAnchor(resolved.key, resolved.viewportOffset).kind === 'scheduled';
	}

	#publishPinned(pinned: boolean): void {
		this.#configuredPinned = pinned;
	}

	#publishVisibility(visible: boolean): void {
		if (visible === this.#configuredVisible) return;
		if (!visible) {
			this.prepareForHide();
			return;
		}
		this.#configuredVisible = true;
		const anchor = this.#resolveAnchor(this.#hiddenAnchor, this.#configuredModel);
		const target: VirtualResumeTarget =
			this.#pendingEndScroll || this.options.pinned
				? { kind: 'end' }
				: anchor
					? { kind: 'anchor', key: anchor.key, viewportOffset: anchor.viewportOffset }
					: { kind: 'start' };
		this.#hiddenResumeResult = this.#resumeCurrentSurface(target);
		this.#hiddenAnchor = null;
		this.#pendingEndScroll = false;
		if (this.#measureOnShow) {
			this.#measureOnShow = false;
			this.#virt.remeasureAll();
		}
		if (target.kind === 'end') this.#settleEndRestore();
	}

	#resumeCurrentSurface(target: VirtualResumeTarget): HiddenReadingRestoreResult {
		const result = this.#virt.resume(target);
		if (result.kind === 'not-ready') return 'not-ready';
		if (result.kind === 'missing-key') return 'missing-anchor';
		return 'restored';
	}

	#settleEndRestore(): void {
		const epoch = ++this.#endRestoreEpoch;
		void settleConversationEndRestore({
			isCurrent: () => epoch === this.#endRestoreEpoch && this.isReady(),
			readGeometry: () => {
				const viewport = this.options.viewport;
				return viewport
					? {
							scrollHeight: viewport.scrollHeight,
							sizerSize: this.#virt.snapshot.sizerSize,
							virtualRange: this.#committedVirtualRangeSignature(),
						}
					: null;
			},
			isAtEnd: () => this.isAtEnd(),
			scrollToEnd: () => {
				this.#virt.scrollToEnd();
			},
			complete: () => this.options.onInitialEndRestored?.(),
		});
	}

	#committedVirtualRangeSignature(): string | null {
		const viewport = this.options.viewport;
		return viewport
			? this.#mountedItems.committedViewportRangeSignature({
					snapshot: this.#virt.snapshot,
					configuredKeys: this.#configuredGeometry.keys,
					position: this.#virt.viewportPosition,
					viewportSize: viewport.clientHeight,
				})
			: null;
	}

	#measurementAnchor(): 'geometric' | 'end' {
		return this.#configuredPinned &&
			this.#configuredGeometry.endBehavior === 'restore-if-pinned' &&
			this.#activeTargetScrolls === 0
			? 'end'
			: 'geometric';
	}

	#acknowledgeData(projectedDataRevision: number): void {
		this.#appliedDataRevision = Math.max(this.#appliedDataRevision, projectedDataRevision);
	}

	#pruneItemAttachments(): void {
		for (const key of this.#itemAttachments.keys()) {
			if (!this.#configuredModel.indexByKey.has(key)) this.#itemAttachments.delete(key);
		}
	}

	#cancelTargetScroll(): void {
		this.#targetToken += 1;
	}
}

function transcriptKeys(model: ConversationVirtualFeedModel): ReadonlySet<string> {
	return new Set(model.items.flatMap((item) => (item.kind === 'transcript' ? [item.key] : [])));
}
