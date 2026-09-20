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
import {
	conversationProjectionMutationAnchor,
	remapConversationAnchor,
} from './conversation-feed-anchor-remapping.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import type {
	ConversationVirtualFeedModel,
	ConversationVirtualTarget,
	ToolGroupVirtualFeedItem,
} from './conversation-feed-virtual-items.js';

export const CHAT_VIRTUAL_OVERSCAN = 6;
const CHAT_FALLBACK_VIEWPORT_HEIGHT = 720;
const MAX_SETTLE_ITERATIONS = 8;
const MAX_TARGET_READY_ITERATIONS = 180;
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
	revealToolGroup?(memberRowId: string): Promise<'applied' | 'cancelled'>;
	onInitialEndRestored?(): void;
	onTransaction?(record: VirtualTransactionRecord): void;
}

interface ConversationProjectionApplication {
	readonly next: ConversationFeedProjection;
	readonly pinned: boolean;
	readonly scrollbarDragActive: boolean;
}

interface FocusedToolGroupTransfer {
	readonly button: HTMLButtonElement;
	readonly memberIds: ReadonlySet<string>;
	readonly surfaceIdentity: string;
}

type ToolGroupFocusTarget =
	| { readonly kind: 'group'; readonly key: string; readonly anchorId: string }
	| { readonly kind: 'member'; readonly key: string; readonly rowId: string };

interface PendingToolGroupFocus extends FocusedToolGroupTransfer {
	readonly target: ToolGroupFocusTarget;
	readonly release: () => void;
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
	#pendingResumeTarget: VirtualResumeTarget | null = null;
	#nativeScrollActivity: ConversationNativeScrollActivity = 'idle';
	#pendingEndScroll = false;
	#pendingEndFlushQueued = false;
	#remeasureOnShow = false;
	#hiddenViewportWidth: number | null = null;
	#earlierPrependAnchor = new ConversationEarlierPrependAnchorOwnership();
	#mountedItems = new ConversationMountedVirtualItems();
	#itemAttachments = new Map<string, Attachment<HTMLElement>>();
	#lastTransaction: VirtualTransactionRecord | null = null;
	#pendingToolGroupFocus: PendingToolGroupFocus | null = null;
	#toolGroupFocusFramePending = false;
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
			initialViewportSize: CHAT_FALLBACK_VIEWPORT_HEIGHT,
			get overscan() {
				return CHAT_VIRTUAL_OVERSCAN;
			},
			get measurementAnchor() {
				return measurementAnchor();
			},
			onTransaction: (record) => {
				this.#lastTransaction = record;
				this.#completeSettledEarlierPrepend(record);
				options.onTransaction?.(record);
			},
		});
		this.viewport = this.#virt.viewport;
		this.sizer = this.#virt.sizer;
		const initialResult = this.#virt.apply({
			kind: 'update',
			keys: this.#configuredGeometry.keys,
			estimates: this.#configuredGeometry.estimates,
			anchor: { kind: 'none' },
		});
		if (initialResult.kind === 'rejected')
			this.#configuredGeometry = { ...this.#configuredGeometry, geometryRevision: -1 };
		if (!this.#configuredVisible) this.#virt.suspend();
		$effect(() => this.#acknowledgeData(options.projectedDataRevision));
		$effect(() => this.#publishPinned(options.pinned));
		$effect(() => this.#publishVisibility(options.visible));
		$effect(() => {
			void options.viewport;
			void options.virtualRoot;
			this.#resumePendingSurface();
			if (this.#nativeScrollActivity === 'idle') this.#queuePendingEndScrollFlush();
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
		return retainedConversationRange({
			overscanRange: snapshot.overscanRange,
			visibleRange: snapshot.visibleRange,
			count: snapshot.positions.count,
			retainedIndexes: retained,
			trailingStartIndex: trailingStart,
			followingRowCount: CHAT_VIRTUAL_FOLLOWING_BUFFER_ROWS,
		});
	}

	applyProjection(input: ConversationProjectionApplication): boolean {
		const nextGeometry = input.next.geometry;
		if (
			nextGeometry.surfaceIdentity === this.#configuredGeometry.surfaceIdentity &&
			nextGeometry.geometryRevision === this.#configuredGeometry.geometryRevision
		) {
			this.#configuredModel = input.next.model;
			this.#appliedDataRevision = Math.max(
				this.#appliedDataRevision,
				input.next.projectedDataRevision,
			);
			return true;
		}
		const identityChanged =
			nextGeometry.surfaceIdentity !== this.#configuredGeometry.surfaceIdentity;
		const previousModel = this.#configuredModel;
		const focusedToolGroup = identityChanged
			? null
			: (this.#focusedToolGroupTransfer(previousModel, input.next.model) ??
				this.#pendingToolGroupFocus);
		const focusTarget = focusedToolGroup
			? this.#toolGroupFocusTarget(input.next.model, focusedToolGroup.memberIds)
			: null;
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
		const selected = identityChanged
			? null
				: remapConversationAnchor(readingAnchor, previousModel, input.next.model);
		const selectedAnchor = selected?.anchor ?? null;
		const nextHiddenAnchor = identityChanged
			? null
				: (remapConversationAnchor(this.#hiddenAnchor, previousModel, input.next.model)?.anchor ?? null);
			const anchor = conversationProjectionMutationAnchor({
				selected,
				restoreEnd,
				explicitNavigation: nextGeometry.endBehavior === 'explicit-navigation',
				targetScrollActive: this.#activeTargetScrolls > 0,
			});
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
		this.#hiddenAnchor = nextHiddenAnchor;
		this.#configuredTranscriptKeys = transcriptKeys(input.next.model);
		this.#configuredPinned = input.pinned;
		this.#appliedDataRevision = Math.max(
			this.#appliedDataRevision,
			input.next.projectedDataRevision,
		);
		if (identityChanged || !focusedToolGroup || !focusTarget) {
			this.#clearPendingToolGroupFocus();
		} else {
			this.#retainToolGroupFocus(focusedToolGroup, focusTarget);
		}
		this.options.retention.prune(nextGeometry.keys);
		this.#pruneItemAttachments();
		const isEarlierPublication = nextGeometry.mutationKinds.has('history-earlier');
		this.#earlierPrependAnchor.carry(selectedAnchor, isEarlierPublication);
		if (isEarlierPublication && this.#lastTransaction?.revision === this.#virt.snapshot.revision) {
			this.#completeSettledEarlierPrepend(this.#lastTransaction);
		}
		this.#layoutMutationToken += 1;
		if (identityChanged) {
			this.options.retention.clear();
			this.#mountedItems.clear();
			this.#itemAttachments.clear();
			this.#hiddenAnchor = null;
			this.#hiddenResumeResult = null;
			this.#remeasureOnShow = false;
			this.#hiddenViewportWidth = null;
			this.#pendingEndScroll = restoreEnd;
			if (this.options.visible)
				this.#resumeCurrentSurface(restoreEnd ? { kind: 'end' } : { kind: 'start' });
		} else if (!this.options.visible && nextGeometry.measurementReset === 'all') {
			this.#remeasureOnShow = true;
		}
		return true;
	}

	prepareForHide(): void {
		if (this.#destroyed || !this.#configuredVisible) return;
		this.#hiddenAnchor = this.options.pinned ? null : this.#captureVirtualAnchor(true);
		this.#hiddenViewportWidth = this.#viewportWidth();
		this.#hiddenResumeResult = null;
		this.#configuredVisible = false;
		this.#pendingResumeTarget = null;
		this.#endRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.cancelPendingLayoutMutation();
		this.#virt.suspend();
	}

	captureRestoreTarget(
		transcriptViewId: string,
		pinned: boolean,
	): ConversationPanelRestoreTarget | null {
		if (pinned) return { kind: 'end' };
		const messageKeys = new Set<string>();
		for (const item of this.#configuredModel.items) {
			if (item.kind === 'tool-group') {
				const first = item.members[0]?.item;
				if (first?.kind === 'message' && first.ordinal !== undefined) {
					messageKeys.add(item.key);
				}
				continue;
			}
			if (
				item.kind !== 'transcript' ||
				item.item.kind !== 'message' ||
				item.item.ordinal === undefined
			)
				continue;
			messageKeys.add(item.key);
		}
		const viewport = this.options.viewport;
		const visibleAnchor = viewport
			? this.#mountedItems.visibleAnchor({
					viewport,
					configuredKeys: this.#configuredGeometry.keys,
					eligibleKeys: messageKeys,
				})
			: null;
		const virtualAnchor = this.#captureVirtualAnchor(true);
		const anchor = visibleAnchor ?? virtualAnchor;
		if (!anchor) return null;
		for (const key of [anchor.key, ...anchor.fallbackKeys]) {
			const index = this.#configuredModel.indexByKey.get(key);
			if (index === undefined) continue;
			const virtualItem = this.#configuredModel.items[index];
			if (virtualItem?.kind === 'tool-group') {
				const first = virtualItem.members[0]?.item;
				if (first?.kind !== 'message' || first.ordinal === undefined) continue;
				return {
					kind: 'group-summary',
					transcriptViewId,
					ordinal: first.ordinal,
					viewportOffset: key === anchor.key ? anchor.viewportOffset : 0,
				};
			}
			if (
				virtualItem?.kind !== 'transcript' ||
				virtualItem.item.kind !== 'message' ||
				virtualItem.item.ordinal === undefined
			)
				continue;
			return {
				kind: 'row',
				transcriptViewId,
				ordinal: virtualItem.item.ordinal,
				viewportOffset: key === anchor.key ? anchor.viewportOffset : 0,
			};
		}
		return null;
	}

	finishScrollbarDrag(): void {
		this.#earlierPrependAnchor.finishScrollbarDrag();
	}

	isReady(): boolean {
		return !this.#destroyed && this.options.visible && this.#virt.viewportPosition !== null;
	}

	hasCollapsedToolGroups(): boolean {
		return this.#configuredModel.collapsedGroupByMemberRowId.size > 0;
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
		if (this.#deferPinnedEndScroll()) return;
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
				this.#scrollToEndForPinnedFollow();
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
		this.#nativeScrollActivity = activity;
		this.#virt.setScrollActivity(activity);
		if (activity === 'idle') this.#queuePendingEndScrollFlush();
	}

	refreshLayout(): void {
		this.#virt.refreshLayout();
	}

	async scrollToTarget(
		target: ConversationViewportTarget,
		options: { align?: 'center' | 'start' | 'end'; viewportOffset?: number } = {},
	): Promise<ConversationViewportTargetResult> {
		if (this.#destroyed || !this.options.visible) return 'not-ready';
		this.#endRestoreEpoch += 1;
		this.#activeTargetScrolls += 1;
		const token = ++this.#targetToken;
		try {
			for (let attempt = 0; attempt < MAX_TARGET_READY_ITERATIONS; attempt += 1) {
				if (this.isReady()) break;
				await nextConversationLayoutFrame();
				if (token !== this.#targetToken) return 'cancelled';
				if (this.#destroyed || !this.options.visible) return 'not-ready';
			}
			if (!this.isReady()) return 'not-ready';
			this.cancelPendingLayoutMutation();
			await nextConversationLayoutFrame();
			if (token !== this.#targetToken) return 'cancelled';
			if (!this.isReady()) return 'not-ready';
			const memberRowId = this.#memberRowId(target);
			if (
				target.kind !== 'presentation-row' &&
				memberRowId &&
				this.#configuredModel.collapsedGroupByMemberRowId.has(memberRowId)
			) {
				const surface = this.#configuredGeometry.surfaceIdentity;
				const revealed = await this.options.revealToolGroup?.(memberRowId);
				if (token !== this.#targetToken || surface !== this.#configuredGeometry.surfaceIdentity) {
					return 'cancelled';
				}
				if (revealed !== 'applied' || !this.isReady()) return 'not-ready';
				if (this.#configuredModel.collapsedGroupByMemberRowId.has(memberRowId)) return 'cancelled';
			}
			const model = this.#configuredModel;
			const resolved = this.#resolveTarget(target, model);
			if (!resolved) return 'target-missing';
			const key = model.items[resolved.index]?.key;
			if (!key) return 'target-missing';
			const releaseTarget = this.options.retention.acquire(key, 'target');
			try {
				const align = options.viewportOffset === undefined ? (options.align ?? 'center') : 'start';
				this.#virt.scrollToIndex(resolved.index, { align });
				return await settleConversationTarget({
					root: () => this.options.virtualRoot,
					rowId: resolved.innerRowId,
					viewport: () => this.options.viewport,
					align,
					viewportOffset: options.viewportOffset,
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
		this.#clearPendingToolGroupFocus();
		this.#endRestoreEpoch += 1;
		this.#cancelTargetScroll();
		this.#earlierPrependAnchor.clear();
		this.#mountedItems.clear();
		this.#itemAttachments.clear();
		this.#pendingResumeTarget = null;
		this.#virt.destroy();
	}

	#captureVirtualAnchor(preferTranscript: boolean): ConversationVirtualAnchor | null {
		let eligibleTranscriptKeys = this.#configuredTranscriptKeys;
		if (preferTranscript) {
			// Structural anchors use mounted rows because native scrolling can outrun the snapshot range.
			const mountedTranscriptKeys = this.#mountedItems.transcriptKeys(
				this.#configuredGeometry.keys,
				this.#configuredTranscriptKeys,
			);
			if (mountedTranscriptKeys.size > 0) eligibleTranscriptKeys = mountedTranscriptKeys;
		}
		return captureConversationVirtualAnchor({
			snapshot: this.#virt.snapshot,
			position: this.#virt.viewportPosition,
			keys: this.#configuredGeometry.keys,
			transcriptKeys: eligibleTranscriptKeys,
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
		if (!key) return null;
		return {
			key,
			viewportOffset: key === anchor.key ? anchor.viewportOffset : 0,
			fallbackKeys: [],
		};
	}

	#focusedToolGroupTransfer(
		previous: ConversationVirtualFeedModel,
		next: ConversationVirtualFeedModel,
	): FocusedToolGroupTransfer | null {
		if (typeof document === 'undefined') return null;
		const button = document.activeElement;
		if (!(button instanceof HTMLButtonElement) || !button.matches('[data-chat-tool-group]')) {
			return null;
		}
		const root = this.options.virtualRoot;
		if (!root?.contains(button)) return null;
		const key = button.closest<HTMLElement>('[data-chat-virtual-item]')?.dataset.chatVirtualItem;
		const index = key === undefined ? undefined : previous.indexByKey.get(key);
		const oldGroup = index === undefined ? undefined : previous.items[index];
		if (oldGroup?.kind !== 'tool-group') return null;
		const memberIds = new Set(oldGroup.members.map((member) => member.item.id));
		const replacement = this.#toolGroupFocusTarget(next, memberIds);
		if (!replacement || replacement.key === oldGroup.key) return null;
		return { button, memberIds, surfaceIdentity: this.#configuredGeometry.surfaceIdentity };
	}

	#toolGroupFocusTarget(
		model: ConversationVirtualFeedModel,
		memberIds: ReadonlySet<string>,
	): ToolGroupFocusTarget | null {
		const group = model.items.find(
			(item): item is ToolGroupVirtualFeedItem =>
				item.kind === 'tool-group' && item.members.some((member) => memberIds.has(member.item.id)),
		);
		if (group) return { kind: 'group', key: group.key, anchorId: group.anchorId };
		for (const rowId of memberIds) {
			const index = model.indexByRowId.get(rowId);
			const item = index === undefined ? undefined : model.items[index];
			if (item?.kind === 'transcript' && item.item.id === rowId) {
				return { kind: 'member', key: item.key, rowId };
			}
		}
		return null;
	}

	#retainToolGroupFocus(
		transfer: FocusedToolGroupTransfer,
		target: ToolGroupFocusTarget,
	): void {
		if (this.#pendingToolGroupFocus?.target.key !== target.key) {
			const release = this.options.retention.acquire(target.key, 'focus');
			this.#clearPendingToolGroupFocus();
			this.#pendingToolGroupFocus = {
				...transfer,
				target,
				release,
			};
		}
		if (this.#toolGroupFocusFramePending) return;
		this.#toolGroupFocusFramePending = true;
		void nextConversationLayoutFrame().then(() => {
			this.#toolGroupFocusFramePending = false;
			const pending = this.#pendingToolGroupFocus;
			if (!pending) return;
			if (
				this.#destroyed ||
				this.#configuredGeometry.surfaceIdentity !== pending.surfaceIdentity ||
				(document.activeElement !== pending.button && document.activeElement !== document.body)
			) {
				this.#clearPendingToolGroupFocus();
				return;
			}
			const selector = pending.target.kind === 'group'
				? '[data-chat-tool-group]'
				: '[data-chat-row-id]';
			const candidates = this.options.virtualRoot?.querySelectorAll<HTMLElement>(selector);
			const replacement = [...(candidates ?? [])].find((element) =>
				pending.target.kind === 'group'
					? element.dataset.chatAnchorId === pending.target.anchorId
					: element.dataset.chatRowId === pending.target.rowId,
			);
			if (replacement && pending.target.kind === 'member') replacement.tabIndex = -1;
			replacement?.focus({ preventScroll: true });
			this.#clearPendingToolGroupFocus();
		});
	}

	#clearPendingToolGroupFocus(): void {
		this.#pendingToolGroupFocus?.release();
		this.#pendingToolGroupFocus = null;
	}

	#memberRowId(target: ConversationViewportTarget): string | undefined {
		if (target.kind === 'dom-anchor') {
			return this.#configuredModel.memberRowIdByDomAnchorId.get(target.id);
		}
		return target.id;
	}

	#resolveTarget(
		target: ConversationViewportTarget,
		model: ConversationVirtualFeedModel,
	): ConversationVirtualTarget | undefined {
		if (target.kind === 'dom-anchor') return model.targetByDomAnchorId.get(target.id);
		const index = model.indexByRowId.get(target.id);
		if (index === undefined) return undefined;

		let innerRowId = target.id;
		const item = model.items[index];
		if (target.kind === 'presentation-row' && item?.kind === 'tool-group') {
			innerRowId = item.anchorId;
		}
		return { index, innerRowId };
	}

	#restoreVirtualAnchor(anchor: ConversationVirtualAnchor): boolean {
		const resolved = this.#resolveAnchor(anchor, this.#configuredModel);
		if (!resolved) return false;
		return this.#virt.scrollToAnchor(resolved.key, resolved.viewportOffset).kind === 'scheduled';
	}

	#publishPinned(pinned: boolean): void {
		this.#configuredPinned = pinned;
		if (!pinned) this.#pendingEndScroll = false;
	}

	#publishVisibility(visible: boolean): void {
		if (visible === this.#configuredVisible) return;
		if (!visible) {
			this.prepareForHide();
			return;
		}
		this.#invalidateMeasurementsAfterHiddenResize();
		this.#configuredVisible = true;
		const anchor = this.#resolveAnchor(this.#hiddenAnchor, this.#configuredModel);
		let target: VirtualResumeTarget = { kind: 'start' };
		if (this.#pendingEndScroll || this.options.pinned) {
			target = { kind: 'end' };
		} else if (anchor) {
			target = { kind: 'anchor', key: anchor.key, viewportOffset: anchor.viewportOffset };
		}
		this.#hiddenResumeResult = this.#resumeCurrentSurface(target);
		this.#hiddenAnchor = null;
		this.#pendingEndScroll = false;
		if (this.#remeasureOnShow) {
			this.#remeasureOnShow = false;
			this.#virt.remeasureAll();
		}
	}

	#invalidateMeasurementsAfterHiddenResize(): void {
		const previousWidth = this.#hiddenViewportWidth;
		const currentWidth = this.#viewportWidth();
		this.#hiddenViewportWidth = null;
		if (previousWidth === null || currentWidth === null || previousWidth === currentWidth) return;
		const result = this.#virt.apply({
			kind: 'reset-measurements',
			keys: this.#configuredGeometry.keys,
			estimates: this.#configuredGeometry.estimates,
			anchor: { kind: 'none' },
		});
		if (result.kind === 'applied') this.#remeasureOnShow = true;
	}

	#viewportWidth(): number | null {
		const width = this.options.viewport?.clientWidth;
		if (!width || !Number.isFinite(width)) return null;
		return width;
	}

	#resumeCurrentSurface(target: VirtualResumeTarget): HiddenReadingRestoreResult {
		const result = this.#virt.resume(target);
		if (result.kind === 'not-ready') {
			this.#pendingResumeTarget = target;
			return 'not-ready';
		}
		this.#pendingResumeTarget = null;
		if (result.kind === 'missing-key') return 'missing-anchor';
		if (target.kind === 'end') this.#settleEndRestore();
		return 'restored';
	}

	#resumePendingSurface(): void {
		const target = this.#pendingResumeTarget;
		if (!target || !this.#configuredVisible) return;
		this.#resumeCurrentSurface(target);
	}

	#deferPinnedEndScroll(): boolean {
		if (this.#nativeScrollActivity === 'idle' || !this.#configuredPinned) return false;
		this.#pendingEndScroll = true;
		return true;
	}

	#scrollToEndForPinnedFollow(): void {
		if (!this.#deferPinnedEndScroll()) this.#virt.scrollToEnd();
	}

	#queuePendingEndScrollFlush(): void {
		if (!this.#pendingEndScroll || this.#pendingEndFlushQueued) return;
		this.#pendingEndFlushQueued = true;
		queueMicrotask(() => {
			this.#pendingEndFlushQueued = false;
			if (this.#destroyed || this.#nativeScrollActivity !== 'idle' || !this.#pendingEndScroll) {
				return;
			}
			if (!this.#configuredPinned) {
				this.#pendingEndScroll = false;
				return;
			}
			if (!this.isReady()) return;
			this.#pendingEndScroll = false;
			if (this.isAtEnd()) return;
			this.#virt.scrollToEnd();
			this.#settleEndRestore();
		});
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
				this.#scrollToEndForPinnedFollow();
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

	#completeSettledEarlierPrepend(record: VirtualTransactionRecord): void {
		if (record.deviationAfter !== 0) return;
		if (!['items', 'mount', 'resize', 'viewport'].includes(record.source)) return;
		this.#earlierPrependAnchor.complete();
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
	const keys = new Set<string>();
	for (const item of model.items) {
		if (item.kind === 'transcript' || item.kind === 'tool-group') keys.add(item.key);
	}
	return keys;
}
