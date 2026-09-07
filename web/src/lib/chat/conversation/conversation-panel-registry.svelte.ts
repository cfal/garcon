import {
	ActiveTranscriptState,
	type ChatLoadMessagesOptions,
	type SharedTranscriptCommit,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type {
	ChatTranscriptApplyResult,
	ChatTranscriptCache,
} from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ConversationFeedPresentationPort } from '$lib/chat/transcript/conversation-feed-presentation-port.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
import type { OptimisticUserInput } from '$lib/chat/transcript/optimistic-user-input.js';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import {
	TranscriptReconnectReplayState,
	type TranscriptBufferedBatch,
	type TranscriptReplayApplyResult,
} from '$lib/chat/transcript/transcript-reconnect-replay.js';
import {
	ConversationTranscriptOverlayStore,
	type ConversationTranscriptOverlayMutation,
} from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import type { ConversationLifecycleRegistry } from './conversation-lifecycle-registry.svelte.js';
import type { ConversationLifecycleState } from './conversation-lifecycle-state.svelte.js';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import type { VisibleChatPresentation } from '$lib/workspace/visible-presentations.js';
import type {
	ChatSurfaceTransfer,
	ChatSurfaceTransferPort,
} from '$lib/workspace/chat-surface-transfer.js';
import type { WorkspacePublication } from '$lib/workspace/workspace-commit.js';

export type ConversationPanelSnapshotAdmission = 'deferred' | 'admitted';

export interface ConversationPanelDescriptor extends VisibleChatPresentation {
	readonly snapshotAdmission: ConversationPanelSnapshotAdmission;
}

export interface CommittedTranscriptBatch {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly messages: TranscriptMessage[];
	readonly firstOrdinal: number;
	readonly lastOrdinal: number;
	readonly resendCandidates: ResendCandidate[];
	readonly noticeRevision: number;
}

export interface ConversationPanelPresentationPort {
	getScrollContainer(): HTMLDivElement | null;
	getViewport(): ConversationViewportPort | null;
	getQueueContainer(): HTMLDivElement | undefined;
	captureRestoreTarget(): ConversationPanelRestoreTarget | null;
	closeTransients(): void;
}

export interface ConversationPanelRegistration {
	readonly surfaceId: ChatViewSurfaceId;
	readonly chatId: string;
	readonly transcript: ActiveTranscriptState;
	readonly lifecycle: ConversationLifecycleState;
	readonly scroll: ConversationScrollController;
	attachPresentation(port: ConversationPanelPresentationPort): () => void;
	captureRestoreTarget(): ConversationPanelRestoreTarget;
	resumePendingRestore(): void;
	prepareForInteractionLoss(): void;
	prepareForHide(): ConversationPanelRestoreTarget;
	restore(target: ConversationPanelRestoreTarget | null): Promise<void>;
	destroy(): void;
}

export type ConversationPanelBatchApplyResult =
	| {
			readonly kind: 'applied';
			readonly localRecoverySurfaceIds: readonly ChatViewSurfaceId[];
	  }
	| {
			readonly kind: 'chat-recovery-required';
			readonly outcome: Exclude<ChatTranscriptApplyResult, { status: 'applied' }>;
	  };

interface StoredRestoreTarget {
	readonly chatId: string;
	readonly target: ConversationPanelRestoreTarget;
}

interface PendingSurfaceTransfer extends StoredRestoreTarget {
	readonly token: number;
}

interface SnapshotLoad {
	readonly minimumLimit: number;
	readonly purpose: ChatLoadMessagesOptions['purpose'];
	readonly promise: Promise<boolean>;
}

interface ActivePanelReconnectReplay {
	readonly token: number;
	readonly replayToken: number;
	readonly replay: TranscriptReconnectReplayState;
}

class PanelRegistration implements ConversationPanelRegistration {
	#presentation: ConversationPanelPresentationPort | null = null;
	#lastTarget: ConversationPanelRestoreTarget = { kind: 'end' };
	#restoreEpoch = 0;
	#readyRestoreEpoch: number | null = null;
	#applyingRestoreEpoch: number | null = null;
	#restoreResumeRequested = false;
	#destroyed = false;
	#snapshotAdmission: ConversationPanelSnapshotAdmission;

	readonly transcript: ActiveTranscriptState;
	readonly lifecycle: ConversationLifecycleState;
	readonly scroll: ConversationScrollController;

	constructor(
		readonly surfaceId: ChatViewSurfaceId,
		readonly chatId: string,
		snapshotAdmission: ConversationPanelSnapshotAdmission,
		cache: ChatTranscriptCache,
		lifecycle: Pick<ConversationLifecycleRegistry, 'forChat'>,
		overlays: ConversationTranscriptOverlayStore,
		onSnapshotResendCandidates: (chatId: string, candidates: readonly ResendCandidate[]) => void,
	) {
		this.#snapshotAdmission = snapshotAdmission;
		this.transcript = new ActiveTranscriptState(cache, overlays.forChat(chatId), {
			onSnapshotResendCandidates,
		});
		this.transcript.activateChat(chatId);
		this.lifecycle = lifecycle.forChat(chatId);
		this.scroll = new ConversationScrollController({
			getScrollContainer: () => this.#presentation?.getScrollContainer() ?? null,
			getViewport: () => this.#presentation?.getViewport() ?? null,
			getQueueContainer: () => this.#presentation?.getQueueContainer(),
			chatState: this.transcript,
			getChatId: () => (this.#destroyed ? null : this.chatId),
		});
	}

	get snapshotAdmission(): ConversationPanelSnapshotAdmission {
		return this.#snapshotAdmission;
	}

	updateSnapshotAdmission(snapshotAdmission: ConversationPanelSnapshotAdmission): boolean {
		const becameAdmitted =
			this.#snapshotAdmission === 'deferred' && snapshotAdmission === 'admitted';
		this.#snapshotAdmission = snapshotAdmission;
		return becameAdmitted;
	}

	attachPresentation(port: ConversationPanelPresentationPort): () => void {
		if (this.#destroyed) return () => {};
		this.#presentation = port;
		this.scroll.setViewportVisible(true);
		this.resumePendingRestore();
		return () => {
			if (this.#presentation !== port) return;
			this.#lastTarget = port.captureRestoreTarget() ?? this.#lastTarget;
			port.closeTransients();
			this.#presentation = null;
		};
	}

	resumePendingRestore(): void {
		if (this.#applyingRestoreEpoch !== null) {
			this.#restoreResumeRequested = true;
			return;
		}
		void this.#applyPendingRestore();
	}

	prepareForInteractionLoss(): void {
		this.#presentation?.closeTransients();
	}

	captureRestoreTarget(): ConversationPanelRestoreTarget {
		if (this.#presentation) {
			this.#lastTarget = this.#presentation.captureRestoreTarget() ?? this.#lastTarget;
		}
		return this.#lastTarget;
	}

	prepareForHide(): ConversationPanelRestoreTarget {
		const target = this.captureRestoreTarget();
		this.#presentation?.closeTransients();
		this.scroll.setViewportVisible(false);
		this.scroll.cancelNativeScroll();
		this.transcript.invalidatePendingHistoryLoad();
		this.transcript.invalidatePendingWindowNavigation();
		return target;
	}

	async restore(
		target: ConversationPanelRestoreTarget | null,
		loadSnapshot?: (options: ChatLoadMessagesOptions) => Promise<boolean>,
	): Promise<void> {
		if (this.#destroyed) return;
		const restoreEpoch = ++this.#restoreEpoch;
		this.#readyRestoreEpoch = null;
		this.#lastTarget = target ?? { kind: 'end' };
		const restored = this.transcript.activateChat(this.chatId);
		if (!restored || restored.stale) {
			const loadOptions = { minimumLimit: restored?.count ?? 0 };
			if (loadSnapshot) await loadSnapshot(loadOptions);
			else await this.transcript.loadMessages(this.chatId, loadOptions);
		}
		if (this.#destroyed || restoreEpoch !== this.#restoreEpoch) return;
		this.#readyRestoreEpoch = restoreEpoch;
		await this.#applyPendingRestore();
	}

	async #applyPendingRestore(): Promise<void> {
		const restoreEpoch = this.#readyRestoreEpoch;
		if (
			this.#destroyed ||
			restoreEpoch === null ||
			restoreEpoch !== this.#restoreEpoch ||
			this.#applyingRestoreEpoch !== null
		)
			return;
		if (this.#lastTarget.kind === 'end') {
			this.#prepareInitialBottomRestore();
			return;
		}
		if (this.#lastTarget.transcriptViewId !== this.transcript.transcriptViewId) {
			this.#lastTarget = { kind: 'end' };
			this.#prepareInitialBottomRestore();
			return;
		}
		if (!this.#presentation) return;
		this.#applyingRestoreEpoch = restoreEpoch;
		this.scroll.setPinnedToBottom(false);
		try {
			const result = await this.scroll.jumpToMessageRow(
				{
					chatId: this.chatId,
					transcriptViewId: this.#lastTarget.transcriptViewId,
					rowId: `${this.#lastTarget.transcriptViewId}:${this.#lastTarget.ordinal}`,
				},
				{ viewportOffset: this.#lastTarget.viewportOffset },
			);
			if (
				result === 'completed' &&
				restoreEpoch === this.#restoreEpoch &&
				restoreEpoch === this.#readyRestoreEpoch
			)
				this.#readyRestoreEpoch = null;
		} finally {
			if (this.#applyingRestoreEpoch === restoreEpoch) this.#applyingRestoreEpoch = null;
			if (this.#restoreResumeRequested) {
				this.#restoreResumeRequested = false;
				void this.#applyPendingRestore();
			}
		}
	}

	#prepareInitialBottomRestore(): void {
		this.#readyRestoreEpoch = null;
		this.scroll.setPinnedToBottom(true);
		this.scroll.prepareInitialBottomRestore(this.chatId);
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.prepareForHide();
		this.#destroyed = true;
		this.#presentation = null;
		this.transcript.clearMessages();
	}
}

export class ConversationPanelRegistry implements ChatSurfaceTransferPort {
	#panels = new Map<ChatViewSurfaceId, PanelRegistration>();
	#restoreTargets = new Map<ChatViewSurfaceId, StoredRestoreTarget>();
	#pendingSurfaceTransfers = new Map<ChatViewSurfaceId, PendingSurfaceTransfer>();
	#surfaceTransferToken = 0;
	#snapshotLoads = new Map<string, SnapshotLoad>();
	#reconnectReplayEpoch = 0;
	#reconnectReplays = new Map<string, ActivePanelReconnectReplay>();
	// Reconciliation updates this reactive revision after mutating the plain panel map.
	#visible = $state.raw<readonly ConversationPanelDescriptor[]>([]);

	constructor(
		private readonly options: {
			cache: ChatTranscriptCache;
			lifecycle: Pick<ConversationLifecycleRegistry, 'forChat' | 'remove'>;
			overlays: ConversationTranscriptOverlayStore;
			getComposerAnchorSurfaceId(): ChatViewSurfaceId | null;
			getSelectedChatId(): string | null;
			loadTranscriptSnapshot?: (
				transcript: ActiveTranscriptState,
				chatId: string,
				options: ChatLoadMessagesOptions,
			) => Promise<void>;
		},
	) {}

	get transcriptCache(): ChatTranscriptCache {
		return this.options.cache;
	}

	prepareForReconcile(visible: readonly ConversationPanelDescriptor[]): void {
		const desired = new Map(visible.map((item) => [item.surfaceId, item]));
		for (const [surfaceId, panel] of this.#panels) {
			const next = desired.get(surfaceId);
			if (next?.chatId === panel.chatId) continue;
			this.#restoreTargets.set(surfaceId, {
				chatId: panel.chatId,
				target: panel.prepareForHide(),
			});
		}
	}

	prepareChatSurfaceTransfer(transfer: ChatSurfaceTransfer): WorkspacePublication {
		const token = ++this.#surfaceTransferToken;
		const destinationPanel = this.#panels.get(transfer.destinationSurfaceId);
		const destinationTarget = this.#restoreTargets.get(transfer.destinationSurfaceId);
		const preserveDestination =
			destinationPanel?.chatId === transfer.chatId || destinationTarget?.chatId === transfer.chatId;
		const target = this.#captureSurfaceTransferTarget(transfer);

		return {
			publish: () => {
				if (preserveDestination) return;
				this.#pendingSurfaceTransfers.set(transfer.destinationSurfaceId, {
					token,
					chatId: transfer.chatId,
					target,
				});
			},
			rollback: () => {
				if (this.#pendingSurfaceTransfers.get(transfer.destinationSurfaceId)?.token === token) {
					this.#pendingSurfaceTransfers.delete(transfer.destinationSurfaceId);
				}
			},
		};
	}

	overlayFor(chatId: string) {
		return this.options.overlays.viewFor(chatId);
	}

	noticeRevisionFor(chatId: string): number {
		return this.options.overlays.noticeRevisionFor(chatId);
	}

	reconcile(visible: readonly ConversationPanelDescriptor[]): void {
		const desired = new Map(visible.map((item) => [item.surfaceId, item]));
		const admittedChatIds = new Set<string>();
		for (const [surfaceId, panel] of this.#panels) {
			const next = desired.get(surfaceId);
			if (next?.chatId === panel.chatId) continue;
			const prepared = this.#restoreTargets.get(surfaceId);
			if (prepared?.chatId !== panel.chatId) {
				this.#restoreTargets.set(surfaceId, {
					chatId: panel.chatId,
					target: panel.prepareForHide(),
				});
			}
			panel.destroy();
			this.#panels.delete(surfaceId);
		}
		for (const item of visible) {
			const existing = this.#panels.get(item.surfaceId);
			if (existing) {
				if (existing.updateSnapshotAdmission(item.snapshotAdmission)) {
					admittedChatIds.add(item.chatId);
				}
				this.#pendingSurfaceTransfers.delete(item.surfaceId);
				continue;
			}
			const panel = new PanelRegistration(
				item.surfaceId,
				item.chatId,
				item.snapshotAdmission,
				this.options.cache,
				this.options.lifecycle,
				this.options.overlays,
				(snapshotChatId, candidates) => {
					this.replaceResendCandidates(snapshotChatId, candidates);
				},
			);
			this.#panels.set(item.surfaceId, panel);
			const stored = this.#restoreTargets.get(item.surfaceId);
			const transfer = this.#pendingSurfaceTransfers.get(item.surfaceId);
			let target: ConversationPanelRestoreTarget | null = null;
			if (transfer?.chatId === item.chatId) {
				target = transfer.target;
			} else if (stored?.chatId === item.chatId) {
				target = stored.target;
			}
			this.#pendingSurfaceTransfers.delete(item.surfaceId);
			this.#restoreTargets.delete(item.surfaceId);
			void panel
				.restore(target, (options) => this.loadChatSnapshot(item.chatId, options))
				.catch(() => {
					this.options.cache.markStale(item.chatId);
				});
		}
		this.#visible = [...visible];
		for (const chatId of admittedChatIds) {
			void this.loadChatSnapshot(chatId).catch(() => {
				this.options.cache.markStale(chatId);
			});
		}
	}

	pruneRemovedSurfaces(existingSurfaceIds: ReadonlySet<ChatViewSurfaceId>): void {
		for (const surfaceId of this.#restoreTargets.keys()) {
			if (!existingSurfaceIds.has(surfaceId)) this.#restoreTargets.delete(surfaceId);
		}
		for (const surfaceId of this.#pendingSurfaceTransfers.keys()) {
			if (!existingSurfaceIds.has(surfaceId)) this.#pendingSurfaceTransfers.delete(surfaceId);
		}
	}

	panel(surfaceId: ChatViewSurfaceId): ConversationPanelRegistration | null {
		void this.#visible;
		return this.#panels.get(surfaceId) ?? null;
	}

	get composerPanel(): ConversationPanelRegistration | null {
		const surfaceId = this.options.getComposerAnchorSurfaceId();
		const selectedChatId = this.options.getSelectedChatId();
		if (!surfaceId || !selectedChatId) return null;
		const panel = this.panel(surfaceId);
		return panel?.chatId === selectedChatId ? panel : null;
	}

	isComposerTarget(surfaceId: ChatViewSurfaceId, chatId: string): boolean {
		return (
			this.options.getComposerAnchorSurfaceId() === surfaceId &&
			this.options.getSelectedChatId() === chatId
		);
	}

	panelsForChat(chatId: string): readonly ConversationPanelRegistration[] {
		void this.#visible;
		return [...this.#panels.values()].filter((panel) => panel.chatId === chatId);
	}

	loadChatSnapshot(chatId: string, options: ChatLoadMessagesOptions = {}): Promise<boolean> {
		if (!this.#hasAdmittedPanel(chatId)) return Promise.resolve(false);
		const minimumLimit = Math.max(0, Math.floor(options.minimumLimit ?? 0));
		const pending = this.#snapshotLoads.get(chatId);
		if (pending) {
			const purposeCovered = options.purpose === undefined || pending.purpose === options.purpose;
			if (pending.minimumLimit >= minimumLimit && purposeCovered) return pending.promise;
			return pending.promise.then(() => this.loadChatSnapshot(chatId, options));
		}
		const operation: SnapshotLoad = {
			minimumLimit,
			purpose: options.purpose,
			promise: this.#performChatSnapshotLoad(chatId, options).finally(() => {
				if (this.#snapshotLoads.get(chatId) === operation) this.#snapshotLoads.delete(chatId);
			}),
		};
		this.#snapshotLoads.set(chatId, operation);
		return operation.promise;
	}

	async #performChatSnapshotLoad(
		chatId: string,
		options: ChatLoadMessagesOptions,
		retryAfterLoaderRemoval = true,
	): Promise<boolean> {
		const loader = [...this.#panels.values()].find(
			(panel) => panel.chatId === chatId && panel.snapshotAdmission === 'admitted',
		);
		if (!loader) return false;
		if (this.options.loadTranscriptSnapshot) {
			await this.options.loadTranscriptSnapshot(loader.transcript, chatId, options);
		} else {
			await loader.transcript.loadMessages(chatId, options);
		}
		const cursor = this.options.cache.readAppliedCursor(chatId);
		if (!cursor || cursor.stale) {
			const loaderWasRemoved = this.#panels.get(loader.surfaceId) !== loader;
			if (retryAfterLoaderRemoval && loaderWasRemoved) {
				return this.#performChatSnapshotLoad(chatId, options, false);
			}
			return false;
		}
		const currentPanels = this.panelsForChat(chatId);
		if (currentPanels.length === 0) return false;
		for (const panel of currentPanels) {
			if (panel !== loader) panel.transcript.installCachedSnapshot(chatId);
		}
		return true;
	}

	#hasAdmittedPanel(chatId: string): boolean {
		return [...this.#panels.values()].some(
			(panel) => panel.chatId === chatId && panel.snapshotAdmission === 'admitted',
		);
	}

	visibleChatIds(): readonly string[] {
		return [...new Set(this.#visible.map((item) => item.chatId))];
	}

	beginReconnectReplay(chatId: string, transcriptViewId: string): number {
		const previous = this.#reconnectReplays.get(chatId);
		if (previous) previous.replay.abort(previous.replayToken);

		const token = ++this.#reconnectReplayEpoch;
		const replay = new TranscriptReconnectReplayState((replayChatId, batch) =>
			this.#applyReconnectReplayBatch(replayChatId, batch),
		);
		const replayToken = replay.begin(chatId, transcriptViewId);
		this.#reconnectReplays.set(chatId, { token, replayToken, replay });
		return token;
	}

	applyReconnectReplayPage(
		token: number,
		chatId: string,
		batch: TranscriptBufferedBatch,
	): TranscriptReplayApplyResult | 'stale' {
		const active = this.#reconnectReplays.get(chatId);
		if (!active || active.token !== token) return 'stale';
		return active.replay.applyPage(active.replayToken, chatId, batch);
	}

	finishReconnectReplay(token: number, chatId: string): TranscriptReplayApplyResult | 'stale' {
		const active = this.#reconnectReplays.get(chatId);
		if (!active || active.token !== token) return 'stale';
		const result = active.replay.finish(active.replayToken, chatId);
		if (this.#reconnectReplays.get(chatId) === active) {
			this.#reconnectReplays.delete(chatId);
		}
		return result;
	}

	abortReconnectReplay(token: number, chatId: string): void {
		const active = this.#reconnectReplays.get(chatId);
		if (!active || active.token !== token) return;
		active.replay.abort(active.replayToken);
		this.#reconnectReplays.delete(chatId);
	}

	abortReconnectReplays(): void {
		for (const active of this.#reconnectReplays.values()) {
			active.replay.abort(active.replayToken);
		}
		this.#reconnectReplays.clear();
	}

	applyCommittedBatch(batch: CommittedTranscriptBatch): ConversationPanelBatchApplyResult {
		const replay = this.#reconnectReplays.get(batch.chatId);
		if (replay?.replay.buffer(batch.chatId, batch)) {
			return { kind: 'applied', localRecoverySurfaceIds: [] };
		}
		const outcome = this.options.cache.applyMessages(batch.chatId, batch.transcriptViewId, {
			firstOrdinal: batch.firstOrdinal,
			lastOrdinal: batch.lastOrdinal,
			messages: batch.messages,
		});
		if (outcome.status !== 'applied') {
			return { kind: 'chat-recovery-required', outcome };
		}
		const overlayMutation = this.options.overlays.applyCommittedBatch(batch);
		const commit: SharedTranscriptCommit = { ...batch, outcome, overlayMutation };
		const localRecoverySurfaceIds: ChatViewSurfaceId[] = [];
		for (const panel of this.#panels.values()) {
			if (panel.chatId !== batch.chatId) continue;
			const result = panel.transcript.applySharedCommit(commit);
			if (overlayMutation.feedStructureChanged) {
				panel.transcript.applySharedOverlayMutation(overlayMutation);
			}
			if (result !== 'applied') localRecoverySurfaceIds.push(panel.surfaceId);
		}
		return { kind: 'applied', localRecoverySurfaceIds };
	}

	appendLocalNotice(chatId: string, noticeType: LocalNoticeType, content: string): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.appendLocalNotice(chatId, noticeType, content),
		);
	}

	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.appendServerNotice(chatId, noticeType, content),
		);
	}

	upsertOptimisticInput(chatId: string, input: OptimisticUserInput): void {
		const cursor = this.options.cache.readAppliedCursor(chatId);
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.upsertOptimisticInput(chatId, input, cursor?.lastOrdinal ?? 0),
		);
	}

	markOptimisticInputDelivered(chatId: string, clientMessageId: string): void {
		const mutation = this.options.overlays.markOptimisticInputDelivered(chatId, clientMessageId);
		if (!mutation) return;
		this.#applyOverlayMutation(chatId, mutation);
	}

	clearOptimisticInput(chatId: string, clientMessageId: string): void {
		const mutation = this.options.overlays.clearOptimisticInput(chatId, clientMessageId);
		if (!mutation) return;
		this.#applyOverlayMutation(chatId, mutation);
	}

	excludeResendCandidate(chatId: string, ordinal: number): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.excludeResendCandidate(chatId, ordinal),
		);
	}

	clearResendExclusions(chatId: string): void {
		this.#applyOverlayMutation(chatId, this.options.overlays.clearResendExclusions(chatId));
	}

	replaceResendCandidates(chatId: string, candidates: readonly ResendCandidate[]): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.replaceResendCandidates(chatId, candidates),
		);
	}

	clearNotices(chatId: string, throughRevision?: number): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.clearNoticesThrough(chatId, throughRevision),
		);
	}

	handleViewReplacement(chatId: string): void {
		this.options.cache.markStale(chatId);
		this.#applyOverlayMutation(chatId, this.options.overlays.resetForTranscriptReplacement(chatId));
		this.#deleteStoredSurfaceStateForChat(chatId);
	}

	removeChat(chatId: string): void {
		for (const [surfaceId, panel] of this.#panels) {
			if (panel.chatId !== chatId) continue;
			panel.destroy();
			this.#panels.delete(surfaceId);
		}
		this.#deleteStoredSurfaceStateForChat(chatId);
		this.options.cache.remove(chatId);
		this.options.overlays.remove(chatId);
		this.options.lifecycle.remove(chatId);
	}

	markChatStale(chatId: string): void {
		this.options.cache.markStale(chatId);
	}

	destroy(): void {
		this.abortReconnectReplays();
		for (const panel of this.#panels.values()) panel.destroy();
		this.#panels.clear();
		this.#restoreTargets.clear();
		this.#pendingSurfaceTransfers.clear();
		this.#snapshotLoads.clear();
		this.#visible = [];
	}

	#applyOverlayMutation(chatId: string, mutation: ConversationTranscriptOverlayMutation): void {
		if (!mutation.feedStructureChanged) return;
		for (const panel of this.#panels.values()) {
			if (panel.chatId === chatId) panel.transcript.applySharedOverlayMutation(mutation);
		}
	}

	#captureSurfaceTransferTarget(transfer: ChatSurfaceTransfer): ConversationPanelRestoreTarget {
		const sourcePanel = this.#panels.get(transfer.sourceSurfaceId);
		if (sourcePanel?.chatId === transfer.chatId) return sourcePanel.captureRestoreTarget();

		const sourceTarget = this.#restoreTargets.get(transfer.sourceSurfaceId);
		if (sourceTarget?.chatId === transfer.chatId) return sourceTarget.target;

		return { kind: 'end' };
	}

	#deleteStoredSurfaceStateForChat(chatId: string): void {
		for (const [surfaceId, stored] of this.#restoreTargets) {
			if (stored.chatId === chatId) this.#restoreTargets.delete(surfaceId);
		}
		for (const [surfaceId, transfer] of this.#pendingSurfaceTransfers) {
			if (transfer.chatId === chatId) this.#pendingSurfaceTransfers.delete(surfaceId);
		}
	}

	#applyReconnectReplayBatch(
		chatId: string,
		batch: TranscriptBufferedBatch,
	): TranscriptReplayApplyResult {
		const result = this.applyCommittedBatch({ chatId, ...batch });
		if (result.kind === 'applied') {
			return result.localRecoverySurfaceIds.length === 0 ? 'applied' : 'gap-detected';
		}
		return result.outcome.status === 'view-changed' ? 'view-changed' : 'gap-detected';
	}
}

export function feedPresentationPort(
	port: ConversationFeedPresentationPort,
	options: {
		getScrollContainer(): HTMLDivElement | null;
		getViewport(): ConversationViewportPort | null;
		getQueueContainer(): HTMLDivElement | undefined;
	},
): ConversationPanelPresentationPort {
	return {
		...options,
		captureRestoreTarget: () => port.captureRestoreTarget(),
		closeTransients: () => port.closeTransients(),
	};
}
