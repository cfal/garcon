import { PanelRegistration, type ConversationPanelRegistration, type ConversationPanelSnapshotAdmission } from './conversation-panel-registration.js';
export type { ConversationPanelRegistration, ConversationPanelPresentationPort, ConversationPanelSnapshotAdmission } from './conversation-panel-registration.js';
import type {
	ChatLoadMessagesOptions,
	SharedTranscriptCommit,
	ActiveTranscriptStateOptions,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type {
	ChatTranscriptApplyResult,
	ChatTranscriptCache,
	TranscriptViewLease,
} from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import {
	InactiveTranscriptWindowStore,
	type InactiveTranscriptWindow,
} from '$lib/chat/transcript/inactive-transcript-window-store.js';
import type { OptimisticUserInput, QueuedSteerReceipt } from '$lib/chat/transcript/optimistic-user-input.js';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
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
import type { ResendCandidate, TranscriptMessage, TranscriptPage } from '$shared/chat-view';
import type { ChatViewSurfaceId, WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import type { VisibleChatPresentation } from '$lib/workspace/visible-presentations.js';
import type {
	ChatSurfaceTransfer,
	ChatSurfaceTransferPort,
} from '$lib/workspace/chat-surface-transfer.js';
import type { WorkspacePublication } from '$lib/workspace/workspace-commit.js';

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
	readonly sourceSurfaceId: ChatViewSurfaceId;
}

interface ActivePanelReconnectReplay {
	readonly lease: TranscriptViewLease;
	readonly token: number;
	readonly replayToken: number;
	readonly replay: TranscriptReconnectReplayState;
}

function waitForSnapshot(snapshot: Promise<unknown>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener('abort', abort);
			reject(signal.reason);
		};
		signal.addEventListener('abort', abort, { once: true });
		void snapshot.then(
			() => {
				signal.removeEventListener('abort', abort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort);
				reject(error);
			},
		);
	});
}

export class ConversationPanelRegistry implements ChatSurfaceTransferPort {
	#panels = new Map<ChatViewSurfaceId, PanelRegistration>();
	#inactiveWindows = new InactiveTranscriptWindowStore();
	#restoreTargets = new Map<ChatViewSurfaceId, StoredRestoreTarget>();
	#pendingSurfaceTransfers = new Map<ChatViewSurfaceId, PendingSurfaceTransfer>();
	#surfaceTransferToken = 0;
	#unsubscribeHeadReads: () => void;
	#reconnectReplayEpoch = 0;
	#reconnectReplays = new Map<string, ActivePanelReconnectReplay>();
	// Reconciliation updates this reactive revision after mutating the plain panel map.
	#mounted = $state.raw<readonly ConversationPanelDescriptor[]>([]);
	// Parked transcripts must not retain the reconciliation scope and its retired panels.
	#onSnapshotResendCandidates: NonNullable<ActiveTranscriptStateOptions['onSnapshotResendCandidates']> = (chatId, candidates, frontier) => {
		this.publishSnapshotResendCandidates(chatId, candidates, frontier);
	};
	readonly observeAcceptedTranscriptView: NonNullable<ActiveTranscriptStateOptions['onSnapshotViewAccepted']> = (chatId, acceptance) => {
		if (acceptance.resetOverlays) {
			this.#applyOverlayMutation(chatId, this.options.overlays.resetForTranscriptReplacement(chatId));
		}
		if (acceptance.replaced) {
			this.options.onTranscriptViewReplaced?.(chatId, acceptance.previousViewId!);
			this.#discardReplacedPresentation(chatId);
			for (const panel of this.panelsForChat(chatId)) {
				if (panel.transcript.isLoadingMessages && this.options.cache.headReads.pending(chatId)) continue;
				if (panel.transcript.transcriptViewId === acceptance.viewId) continue;
				panel.transcript.invalidatePendingLoads();
				panel.transcript.installCachedSnapshot(chatId);
			}
		}
		if (this.options.cache.needsSnapshotRecovery(chatId) && !this.options.cache.headReads.pending(chatId)) {
			const lease = this.options.cache.openViewLease(chatId);
			// Lets the publishing panel finish before a successor takes over its loader.
			queueMicrotask(() => {
				if (lease.isCurrent() && this.options.cache.needsSnapshotRecovery(chatId) && !this.options.cache.headReads.pending(chatId)) {
					void this.loadChatSnapshot(chatId).catch(() => {});
				}
			});
		}
	};
	#discardReplacedPresentation(chatId: string): void {
		this.#removeHiddenPanels(chatId);
		this.#inactiveWindows.removeChat(chatId);
		this.#deleteStoredSurfaceStateForChat(chatId);
	}
	readonly observeRecoveredMessages = (chatId: string, messages: readonly TranscriptMessage[]): void => {
		const mutation = this.options.overlays.clearEchoedInputs(chatId, messages);
		if (mutation) this.#applyOverlayMutation(chatId, mutation);
	};
	#recoverTranscript = async (chatId: string, viewId: string): Promise<void> => {
		if (this.resetForViewReplacement(chatId, viewId)) {
			await this.loadChatSnapshot(chatId, { purpose: 'activation' });
			return;
		}
		for (const panel of this.panelsForChat(chatId)) {
			if (panel.transcript.transcriptViewId !== viewId) continue;
			panel.transcript.clearMessages();
			if (!this.options.cache.get(chatId) || panel.transcript.installCachedSnapshot(chatId) !== 'applied') {
				await panel.transcript.loadMessages(chatId);
			}
		}
	};

	constructor(
		private readonly options: {
			cache: ChatTranscriptCache;
			lifecycle: Pick<ConversationLifecycleRegistry, 'forChat' | 'remove'>;
			overlays: ConversationTranscriptOverlayStore;
			onTranscriptViewReplaced?: (chatId: string, previousViewId: string) => void;
			getComposerAnchorSurfaceId(): ChatViewSurfaceId | null;
			getSelectedChatId(): string | null;
			retainInactiveWindows?: () => boolean;
			combineMessages?: boolean;
		},
	) {
		this.#unsubscribeHeadReads = options.cache.headReads.onPublication((chatId, publication) => {
			if (publication.kind === 'cursor-reset') {
				this.#discardReplacedPresentation(chatId);
				this.#applyOverlayMutation(chatId, this.options.overlays.resetForTranscriptReplacement(chatId));
				for (const panel of this.panelsForChat(chatId)) {
					panel.transcript.clearMessages();
					void panel.transcript.loadMessages(chatId).catch(() => {});
				}
				return;
			}
			this.observeAcceptedTranscriptView(chatId, publication.acceptance);
			for (const panel of this.panelsForChat(chatId)) panel.installInitialSnapshot();
		});
	}

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
		const preserveDestination = destinationPanel?.chatId === transfer.chatId;
		const pendingSource = this.#pendingSurfaceTransfers.get(transfer.sourceSurfaceId);
		// A hidden Chat can move again before its previous transfer is consumed.
		const sourceTransfer = pendingSource?.chatId === transfer.chatId ? pendingSource : null;
		const target = sourceTransfer?.target ?? this.#captureSurfaceTransferTarget(transfer);
		let previousTransfer: PendingSurfaceTransfer | undefined;

		return {
			publish: () => {
				if (preserveDestination) return;
				previousTransfer = this.#pendingSurfaceTransfers.get(transfer.destinationSurfaceId);
				this.#pendingSurfaceTransfers.set(transfer.destinationSurfaceId, {
					token,
					chatId: transfer.chatId,
					target,
					sourceSurfaceId: sourceTransfer?.sourceSurfaceId ?? transfer.sourceSurfaceId,
				});
			},
			rollback: () => {
				if (this.#pendingSurfaceTransfers.get(transfer.destinationSurfaceId)?.token !== token)
					return;
				if (previousTransfer) {
					this.#pendingSurfaceTransfers.set(transfer.destinationSurfaceId, previousTransfer);
				} else {
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

	reconcile(
		visible: readonly ConversationPanelDescriptor[],
		fullscreenHidden: readonly VisibleChatPresentation[] = [],
	): void {
		const previous = new Map(this.#mounted.map(item => [item.surfaceId, item]));
		const mounted = [...visible];
		for (const item of fullscreenHidden) {
			if (item.presentation === 'mobile') continue;
			const panel = this.#panels.get(item.surfaceId);
			if (panel?.chatId !== item.chatId || !panel.canRetainPresentation) continue;
			const host = previous.get(item.surfaceId);
			if (host?.presentation !== item.presentation || host.windowId !== item.windowId) continue;
			panel.prepareForHide();
			mounted.push(host);
		}
		// Protects the whole incoming set before any panel hydrates or transfers its transcript.
		this.options.cache.setMountedChatIds(mounted.map((item) => item.chatId));
		const desired = new Map(mounted.map((item) => [item.surfaceId, item]));
		const admittedChatIds = new Set<string>();
		const retainInactive = this.options.retainInactiveWindows?.() ?? false;
		if (!retainInactive) this.#inactiveWindows.clear();
		const retainedForIncoming = new Map<ChatViewSurfaceId, InactiveTranscriptWindow | null>();
		if (retainInactive) {
			for (const item of visible) {
				if (this.#panels.get(item.surfaceId)?.chatId === item.chatId) continue;
				retainedForIncoming.set(item.surfaceId, this.#reserveIncomingWindow(item, desired));
			}
		}
		for (const [surfaceId, panel] of this.#panels) {
			const next = desired.get(surfaceId);
			if (next?.chatId === panel.chatId) {
				if (panel.isPresentationVisible) continue;
				const sameHost = next.presentation === previous.get(surfaceId)?.presentation;
				if (sameHost && panel.canRetainPresentation) continue;
			}
			const prepared = this.#restoreTargets.get(surfaceId);
			if (prepared?.chatId !== panel.chatId) {
				this.#restoreTargets.set(surfaceId, {
					chatId: panel.chatId,
					target: panel.prepareForHide(),
				});
			}
			const transcript = retainInactive && next?.chatId !== panel.chatId ? panel.detachTranscript() : null;
			if (transcript) {
				this.#inactiveWindows.park({
					surfaceId,
					chatId: panel.chatId,
					transcript,
					target: this.#restoreTargets.get(surfaceId)?.target ?? { kind: 'end' },
				});
			} else {
				panel.destroy();
			}
			this.#panels.delete(surfaceId);
		}
		for (const item of visible) {
			const existing = this.#panels.get(item.surfaceId);
			if (existing) {
				existing.resumePresentation();
				this.#restoreTargets.delete(item.surfaceId);
				if (existing.updateSnapshotAdmission(item.snapshotAdmission)) {
					admittedChatIds.add(item.chatId);
				}
				this.#pendingSurfaceTransfers.delete(item.surfaceId);
				continue;
			}
			const transfer = this.#pendingSurfaceTransfers.get(item.surfaceId);
			const retained = retainedForIncoming.get(item.surfaceId) ?? null;
			const panel = new PanelRegistration(
				item.surfaceId,
				item.chatId,
				item.snapshotAdmission,
				this.options.cache,
				this.options.lifecycle,
				this.options.overlays,
				{
					onSnapshotResendCandidates: this.#onSnapshotResendCandidates,
					onRecoveredMessages: this.observeRecoveredMessages,
					onSnapshotViewAccepted: this.observeAcceptedTranscriptView,
					combineMessages: this.options.combineMessages,
					recoverTranscript: this.#recoverTranscript,
				},
				{
					load: (options) => this.loadChatSnapshot(item.chatId, options),
					wait: (signal) => this.#waitForChatSnapshot(item.chatId, signal),
				},
				retained?.transcript,
			);
			this.#panels.set(item.surfaceId, panel);
			const stored = this.#restoreTargets.get(item.surfaceId);
			let target: ConversationPanelRestoreTarget | null = null;
			if (transfer?.chatId === item.chatId) {
				target = transfer.target;
			} else if (stored?.chatId === item.chatId) {
				target = stored.target;
			} else if (retained) {
				target = retained.target;
			}
			this.#pendingSurfaceTransfers.delete(item.surfaceId);
			this.#restoreTargets.delete(item.surfaceId);
			const restoreLease = this.options.cache.openViewLease(item.chatId);
			void (retained ? panel.restoreRetained(target ?? retained.target) : panel.restore(target)).catch(() => {
				if (restoreLease.isCurrent()) this.markChatStale(item.chatId);
			});
		}
		this.#mounted = mounted;
		for (const chatId of admittedChatIds) {
			this.options.cache.markStale(chatId);
			const admissionLease = this.options.cache.openViewLease(chatId);
			void this.loadChatSnapshot(chatId).catch(() => {
				if (admissionLease.isCurrent()) this.markChatStale(chatId);
			});
		}
	}

	pruneRemovedSurfaces(existingSurfaceIds: ReadonlySet<ChatViewSurfaceId>): void {
		this.#inactiveWindows.pruneSurfaces(existingSurfaceIds);
		for (const surfaceId of this.#restoreTargets.keys()) {
			if (!existingSurfaceIds.has(surfaceId)) this.#restoreTargets.delete(surfaceId);
		}
		for (const surfaceId of this.#pendingSurfaceTransfers.keys()) {
			if (!existingSurfaceIds.has(surfaceId)) this.#pendingSurfaceTransfers.delete(surfaceId);
		}
	}

	panel(surfaceId: ChatViewSurfaceId): ConversationPanelRegistration | null {
		void this.#mounted;
		return this.#panels.get(surfaceId) ?? null;
	}

	retainedWindowId(surfaceId: ChatViewSurfaceId): WorkspaceWindowId | null {
		const panel = this.panel(surfaceId);
		if (!panel || panel.isPresentationVisible) return null;
		return this.#mounted.find(item => item.surfaceId === surfaceId)?.windowId ?? null;
	}

	get composerPanel(): ConversationPanelRegistration | null {
		const surfaceId = this.options.getComposerAnchorSurfaceId();
		const selectedChatId = this.options.getSelectedChatId();
		if (!surfaceId || !selectedChatId) return null;
		const panel = this.panel(surfaceId);
		return panel?.chatId === selectedChatId && panel.isPresentationVisible ? panel : null;
	}

	isComposerTarget(surfaceId: ChatViewSurfaceId, chatId: string): boolean {
		return (
			this.options.getComposerAnchorSurfaceId() === surfaceId &&
			this.options.getSelectedChatId() === chatId
		);
	}

	panelsForChat(chatId: string): readonly ConversationPanelRegistration[] {
		void this.#mounted;
		return [...this.#panels.values()].filter((panel) => panel.chatId === chatId);
	}

	async loadChatSnapshot(chatId: string, options: ChatLoadMessagesOptions = {}): Promise<boolean> {
		const loader = this.#findAdmittedPanel(chatId);
		if (!loader) return false;
		const handoffs = new Map(this.panelsForChat(chatId).map(panel => [panel, panel.transcript.snapshotHandoffGuard()]));
		const result = await loader.transcript.loadSnapshot(chatId, options);
		if (result.kind !== 'complete' || !result.lease.isCurrent()) return false;
		const cursor = this.options.cache.readAppliedCursor(chatId);
		if (!cursor || cursor.stale) return false;
		for (const panel of this.panelsForChat(chatId)) {
			if (panel === loader) continue;
			const acceptsHandoff = handoffs.get(panel);
			if (!acceptsHandoff) panel.installInitialSnapshot();
			else if (!panel.transcript.isLoadingMessages && acceptsHandoff()) panel.transcript.installCachedSnapshot(chatId);
		}
		return true;
	}

	invalidateChatSnapshot(chatId: string): void {
		this.options.cache.invalidateSnapshotReads(chatId);
	}

	async #waitForChatSnapshot(chatId: string, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		let pending = this.options.cache.headReads.pending(chatId);
		while (pending) {
			await waitForSnapshot(pending, signal);
			signal.throwIfAborted();
			pending = this.options.cache.headReads.pending(chatId);
		}
	}
	#findAdmittedPanel(chatId: string): PanelRegistration | undefined {
		return [...this.#panels.values()].find(
			(panel) => panel.chatId === chatId && panel.isPresentationVisible && panel.snapshotAdmission === 'admitted',
		);
	}

	visibleChatIds(): readonly string[] {
		return [...new Set(this.#mounted
			.filter(item => this.#panels.get(item.surfaceId)?.isPresentationVisible)
			.map(item => item.chatId))];
	}

	beginReconnectReplay(chatId: string, transcriptViewId: string): number {
		const previous = this.#reconnectReplays.get(chatId);
		if (previous) this.abortReconnectReplay(previous.token, chatId);

		const token = ++this.#reconnectReplayEpoch;
		const replay = new TranscriptReconnectReplayState((replayChatId, batch) =>
			this.#applyReconnectReplayBatch(replayChatId, batch),
		);
		const replayToken = replay.begin(chatId, transcriptViewId);
		this.#reconnectReplays.set(chatId, { token, replayToken, replay, lease: this.options.cache.openViewLease(chatId) });
		return token;
	}

	applyReconnectReplayPage(
		token: number,
		chatId: string,
		batch: TranscriptBufferedBatch,
	): TranscriptReplayApplyResult | 'stale' {
		const active = this.#reconnectReplays.get(chatId);
		if (!active || active.token !== token || !active.lease.isCurrent()) return 'stale';
		return active.replay.applyPage(active.replayToken, chatId, batch);
	}

	finishReconnectReplay(token: number, chatId: string): TranscriptReplayApplyResult | 'stale' {
		const active = this.#reconnectReplays.get(chatId);
		if (!active || active.token !== token || !active.lease.isCurrent()) return 'stale';
		const result = active.replay.finish(active.replayToken, chatId);
		if (this.#reconnectReplays.get(chatId) === active) {
			this.#reconnectReplays.delete(chatId);
		}
		return result;
	}

	abortReconnectReplay(token: number, chatId: string): void {
		const active = this.#reconnectReplays.get(chatId);
		if (!active || active.token !== token) return;
		const discardedLiveCommits = active.replay.abort(active.replayToken);
		this.#reconnectReplays.delete(chatId);
		if (discardedLiveCommits && active.lease.isCurrent()) {
			this.invalidateChatSnapshot(chatId);
			this.markChatStale(chatId);
		}
	}

	abortReconnectReplays(): void {
		for (const [chatId, active] of this.#reconnectReplays) {
			this.abortReconnectReplay(active.token, chatId);
		}
	}

	applyCommittedBatch(batch: CommittedTranscriptBatch): ConversationPanelBatchApplyResult {
		const replay = this.#reconnectReplays.get(batch.chatId);
		if (replay?.lease.isCurrent() && replay.replay.buffer(batch.chatId, batch)) {
			if (this.options.cache.readAppliedCursor(batch.chatId)?.transcriptViewId === batch.transcriptViewId) {
				this.observeRecoveredMessages(batch.chatId, batch.messages);
			}
			return { kind: 'applied', localRecoverySurfaceIds: [] };
		}
		const outcome = this.options.cache.applyMessages(batch.chatId, batch.transcriptViewId, {
			firstOrdinal: batch.firstOrdinal,
			lastOrdinal: batch.lastOrdinal,
			messages: batch.messages,
		});
		if (outcome.status !== 'applied') {
			this.#discardHiddenPanels(batch.chatId);
			this.#inactiveWindows.removeChat(batch.chatId);
			return { kind: 'chat-recovery-required', outcome };
		}
		if (outcome.acceptance) this.observeAcceptedTranscriptView(batch.chatId, outcome.acceptance);
		const overlayMutation = this.options.overlays.applyCommittedBatch(batch);
		const commit: SharedTranscriptCommit = { ...batch, outcome, overlayMutation };
		const localRecoverySurfaceIds: ChatViewSurfaceId[] = [];
		for (const panel of this.#panels.values()) {
			if (panel.chatId !== batch.chatId) continue;
			const result = panel.transcript.applySharedCommit(commit);
			if (overlayMutation.feedStructureChanged) {
				panel.transcript.applySharedOverlayMutation(overlayMutation);
			}
			if (result !== 'applied') {
				if (panel.isPresentationVisible) localRecoverySurfaceIds.push(panel.surfaceId);
				else this.#discardHiddenPanels(batch.chatId);
			}
		}
		this.#inactiveWindows.applySharedCommit(commit, overlayMutation);
		return { kind: 'applied', localRecoverySurfaceIds };
	}

	hasInactiveWindow(chatId: string): boolean {
		return this.#inactiveWindows.hasChat(chatId);
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
		// Direct acceptance retires a live-tail steer without waiting for its echo.
		if (this.#pendingOptimisticInput(chatId, clientMessageId)?.placement === 'live-tail') {
			this.clearOptimisticInput(chatId, clientMessageId);
			return;
		}
		const mutation = this.options.overlays.markOptimisticInputDelivered(chatId, clientMessageId);
		if (!mutation) return;
		this.#applyOverlayMutation(chatId, mutation);
	}

	anchorUnconfirmedSteer(chatId: string, clientMessageId: string): void {
		const input = this.#pendingOptimisticInput(chatId, clientMessageId);
		if (input?.placement !== 'live-tail') return;
		this.upsertOptimisticInput(chatId, { ...input, placement: undefined });
	}

	#pendingOptimisticInput(chatId: string, clientMessageId: string): OptimisticUserInput | undefined {
		const input = this.overlayFor(chatId)?.optimisticInputs.find(input => input.clientMessageId === clientMessageId);
		return input?.delivery === 'pending' ? input : undefined;
	}

	clearOptimisticInput(chatId: string, clientMessageId: string): void {
		const mutation = this.options.overlays.clearOptimisticInput(chatId, clientMessageId);
		if (!mutation) return;
		this.#applyOverlayMutation(chatId, mutation);
	}

	reconcileQueuedSteers(chatId: string, control: ChatExecutionControlState | null, receipt?: QueuedSteerReceipt): void {
		const mutation = this.options.overlays.reconcileQueuedSteers(chatId, control, receipt);
		if (mutation) this.#applyOverlayMutation(chatId, mutation);
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

	publishSnapshotResendCandidates(
		chatId: string,
		candidates: readonly ResendCandidate[],
		frontier: { transcriptViewId: string; lastOrdinal: number },
	): void {
		this.options.overlays.publishSnapshotResendCandidates(chatId, candidates, frontier);
	}

	clearNotices(chatId: string, throughRevision?: number): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.clearNoticesThrough(chatId, throughRevision),
		);
	}

	handleViewReplacement(chatId: string, replacementViewId: string | null = null, previousViewId?: string): boolean {
		const transition = this.options.cache.announceReplacement(chatId, replacementViewId, previousViewId);
		if (transition === 'unchanged') return false;
		if (transition === 'recheck') {
			this.invalidateChatSnapshot(chatId);
			this.options.cache.markStale(chatId);
			return false;
		}
		this.#discardReplacedPresentation(chatId);
		if (transition === 'reset') this.#applyOverlayMutation(chatId, this.options.overlays.resetForTranscriptReplacement(chatId));
		for (const panel of this.panelsForChat(chatId)) panel.transcript.invalidatePendingLoads();
		this.options.cache.markStale(chatId);
		return true;
	}

	resetForViewReplacement(chatId: string, previousViewId: string, replacementViewId: string | null = null): boolean {
		const accepted = this.options.cache.acceptedView(chatId);
		if (accepted && accepted !== previousViewId) return false;
		const replay = this.#reconnectReplays.get(chatId);
		if (replay) this.abortReconnectReplay(replay.token, chatId);
		if (!this.handleViewReplacement(chatId, replacementViewId) && this.options.cache.hasPendingReplacement(chatId)) return true;
		this.options.cache.discardInvalidFrontier(chatId, previousViewId);
		for (const panel of this.panelsForChat(chatId)) panel.transcript.clearMessages();
		return true;
	}

	captureNativeReload(chatId: string): { apply(page: TranscriptPage): void; recoverUnknown(): Promise<void> } {
		const capture = this.options.cache.captureReload(chatId);
		return {
			apply: page => {
				// A broadcast may have installed this view and newer commits before the reply.
				if (!capture.canApply(page.transcriptViewId) || this.options.cache.acceptedView(chatId) === page.transcriptViewId) return;
				this.handleViewReplacement(chatId, page.transcriptViewId);
				const acceptance = this.options.cache.openViewLease(chatId).accept(page.transcriptViewId)!;
				this.options.cache.replaceFromPage(chatId, page);
				this.observeAcceptedTranscriptView(chatId, acceptance);
				for (const panel of this.panelsForChat(chatId)) panel.transcript.installCachedSnapshot(chatId);
				if (this.options.cache.needsSnapshotRecovery(chatId)) {
					this.markChatStale(chatId);
					void this.loadChatSnapshot(chatId).catch(() => {});
				} else {
					this.options.cache.markValidated(chatId);
				}
			},
			recoverUnknown: async () => {
				if (!capture.isCurrent()) return;
				this.options.cache.retireOperations(chatId);
				for (const panel of this.panelsForChat(chatId)) panel.transcript.invalidatePendingLoads();
				this.markChatStale(chatId);
				await this.loadChatSnapshot(chatId);
			},
		};
	}

	removeChat(chatId: string): void {
		this.#inactiveWindows.removeChat(chatId);
		for (const [surfaceId, panel] of this.#panels) {
			if (panel.chatId !== chatId) continue;
			panel.destroy();
			this.#panels.delete(surfaceId);
		}
		this.#deleteStoredSurfaceStateForChat(chatId);
		this.options.cache.remove(chatId);
		this.#mounted = this.#mounted.filter(item => this.#panels.has(item.surfaceId));
		this.options.cache.setMountedChatIds([...this.#panels.values()].map((panel) => panel.chatId));
		this.options.overlays.remove(chatId);
		this.options.lifecycle.remove(chatId);
	}

	markChatStale(chatId: string): void {
		this.#discardHiddenPanels(chatId);
		this.#inactiveWindows.removeChat(chatId);
		this.options.cache.markStale(chatId);
	}

	discardFullscreenHiddenPanels(): void {
		this.#discardHiddenPanels();
	}

	#discardHiddenPanels(chatId?: string): void {
		for (const removedChatId of this.#removeHiddenPanels(chatId)) this.options.cache.markStale(removedChatId);
	}

	#removeHiddenPanels(chatId?: string): ReadonlySet<string> {
		const removed = new Set<string>();
		for (const [surfaceId, panel] of this.#panels) {
			if (panel.isPresentationVisible || (chatId !== undefined && panel.chatId !== chatId)) continue;
			this.#restoreTargets.set(surfaceId, { chatId: panel.chatId, target: panel.captureRestoreTarget() });
			panel.destroy();
			this.#panels.delete(surfaceId);
			removed.add(panel.chatId);
		}
		if (removed.size > 0) {
			this.#mounted = this.#mounted.filter(item => this.#panels.has(item.surfaceId));
			this.options.cache.setMountedChatIds(this.#mounted.map(item => item.chatId));
		}
		return removed;
	}

	destroy(): void {
		this.#unsubscribeHeadReads();
		this.options.cache.retireAllOperations();
		this.#inactiveWindows.clear();
		this.abortReconnectReplays();
		for (const panel of this.#panels.values()) panel.destroy();
		this.#panels.clear();
		this.#restoreTargets.clear();
		this.#pendingSurfaceTransfers.clear();
		this.#mounted = [];
		this.options.cache.setMountedChatIds([]);
	}

	#applyOverlayMutation(chatId: string, mutation: ConversationTranscriptOverlayMutation): void {
		if (!mutation.feedStructureChanged) return;
		for (const panel of this.#panels.values()) {
			if (panel.chatId === chatId) panel.transcript.applySharedOverlayMutation(mutation);
		}
		this.#inactiveWindows.applyOverlayMutation(chatId, mutation);
	}

	#reserveIncomingWindow(
		item: ConversationPanelDescriptor,
		desired: ReadonlyMap<ChatViewSurfaceId, ConversationPanelDescriptor>,
	): InactiveTranscriptWindow | null {
		const transfer = this.#pendingSurfaceTransfers.get(item.surfaceId);
		if (transfer?.chatId !== item.chatId) {
			return this.#inactiveWindows.take(item.surfaceId, item.chatId);
		}

		let retained = this.#inactiveWindows.take(transfer.sourceSurfaceId, item.chatId);
		const sourcePanel = this.#panels.get(transfer.sourceSurfaceId);
		const sourceMovesAway = desired.get(transfer.sourceSurfaceId)?.chatId !== item.chatId;
		if (!retained && sourcePanel?.chatId === item.chatId && sourceMovesAway) {
			const transcript = sourcePanel.detachTranscript();
			if (transcript) {
				retained = {
					surfaceId: transfer.sourceSurfaceId,
					chatId: item.chatId,
					transcript,
					target: transfer.target,
				};
			} else {
				sourcePanel.destroy();
			}
			this.#panels.delete(transfer.sourceSurfaceId);
			this.#restoreTargets.delete(transfer.sourceSurfaceId);
		}

		this.#inactiveWindows.discard(item.surfaceId, item.chatId);
		return retained;
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
