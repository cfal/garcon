import {
	type ActiveTranscriptState,
	type ChatLoadMessagesOptions,
	type SharedTranscriptCommit,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type {
	ChatTranscriptApplyResult,
	ChatTranscriptCache,
} from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import type { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
import { PanelRegistration } from './conversation-panel-registration.svelte.js';
import {
	InactiveTranscriptWindowStore,
	type InactiveTranscriptWindow,
} from '$lib/chat/transcript/inactive-transcript-window-store.js';
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
import type { ChatPresentation } from '$lib/workspace/visible-presentations.js';
import type {
	ChatSurfaceTransfer,
	ChatSurfaceTransferPort,
} from '$lib/workspace/chat-surface-transfer.js';
import type { WorkspacePublication } from '$lib/workspace/workspace-commit.js';
import type {
	TranscriptRowNavigationResult,
	TranscriptRowTarget,
} from '$lib/chat/transcript/transcript-row-navigation.js';

export type ConversationPanelSnapshotAdmission = 'deferred' | 'admitted';

export interface ConversationPanelDescriptor extends ChatPresentation {
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
	prepareForHide(): void;
}

export interface ConversationPanelRegistration {
	readonly surfaceId: ChatViewSurfaceId;
	readonly chatId: string;
	readonly transcript: ActiveTranscriptState;
	readonly lifecycle: ConversationLifecycleState;
	readonly scroll: ConversationScrollController;
	attachPresentation(port: ConversationPanelPresentationPort): () => void;
	captureRestoreTarget(): ConversationPanelRestoreTarget;
	completeInitialBottomRestore(): void;
	resumePendingRestore(): void;
	navigateToTranscriptRow(
		target: TranscriptRowTarget,
		signal: AbortSignal,
		isCurrent: () => boolean,
	): Promise<TranscriptRowNavigationResult>;
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
	readonly sourceSurfaceId: ChatViewSurfaceId;
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
	readonly transcriptViewId: string;
	invalidated: boolean;
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
	#snapshotLoads = new Map<string, SnapshotLoad>();
	#reconnectReplayEpoch = 0;
	#reconnectReplays = new Map<string, ActivePanelReconnectReplay>();
	// Reconciliation updates this reactive revision after mutating the plain panel map.
	#visible = $state.raw<readonly ConversationPanelDescriptor[]>([]);
	// Parked transcripts must not retain the reconciliation scope and its retired panels.
	#onSnapshotResendCandidates = (chatId: string, candidates: readonly ResendCandidate[]): void => {
		this.replaceResendCandidates(chatId, candidates);
	};

	constructor(
		private readonly options: {
			cache: ChatTranscriptCache;
			lifecycle: Pick<ConversationLifecycleRegistry, 'forChat' | 'remove'>;
			overlays: ConversationTranscriptOverlayStore;
			getComposerAnchorSurfaceId(): ChatViewSurfaceId | null;
			getSelectedChatId(): string | null;
			retainInactiveWindows?: () => boolean;
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

	prepareForReconcile(
		visible: readonly ConversationPanelDescriptor[],
		fullscreenHidden: readonly ConversationPanelDescriptor[] = [],
	): void {
		const desired = new Map(visible.map((item) => [item.surfaceId, item]));
		const retained = this.#desiredPanels(visible, fullscreenHidden);
		for (const [surfaceId, panel] of this.#panels) {
			const next = desired.get(surfaceId);
			if (next?.chatId === panel.chatId) continue;
			const target = panel.prepareForHide();
			if (retained.get(surfaceId)?.chatId === panel.chatId) continue;
			this.#restoreTargets.set(surfaceId, {
				chatId: panel.chatId,
				target,
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
					sourceSurfaceId: transfer.sourceSurfaceId,
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

	reconcile(
		visible: readonly ConversationPanelDescriptor[],
		fullscreenHidden: readonly ConversationPanelDescriptor[] = [],
	): void {
		const desired = this.#desiredPanels(visible, fullscreenHidden);
		const snapshotLimitsByChat = new Map<string, number>();
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
			if (next?.chatId === panel.chatId) continue;
			const prepared = this.#restoreTargets.get(surfaceId);
			if (prepared?.chatId !== panel.chatId) {
				this.#restoreTargets.set(surfaceId, {
					chatId: panel.chatId,
					target: panel.prepareForHide(),
				});
			}
			const transcript = retainInactive ? panel.detachTranscript() : null;
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
				const wasHidden = !existing.isPresentationVisible;
				if (wasHidden) this.#restoreFreshCache(existing);
				existing.resumePresentation(item.presentation);
				const becameAdmitted = existing.updateSnapshotAdmission(item.snapshotAdmission);
				const needsRecovery = wasHidden && this.#needsSnapshot(existing);
				if (item.snapshotAdmission === 'admitted' && (becameAdmitted || needsRecovery)) {
					const minimumLimit = needsRecovery ? existing.transcript.entries.length : 0;
					snapshotLimitsByChat.set(
						item.chatId,
						Math.max(snapshotLimitsByChat.get(item.chatId) ?? 0, minimumLimit),
					);
				}
				this.#pendingSurfaceTransfers.delete(item.surfaceId);
				continue;
			}
			const transfer = this.#pendingSurfaceTransfers.get(item.surfaceId);
			const retained = retainedForIncoming.get(item.surfaceId) ?? null;
			const panel = new PanelRegistration(
				item.surfaceId,
				item.chatId,
				item.presentation,
				item.snapshotAdmission,
				this.options.cache,
				this.options.lifecycle,
				this.options.overlays,
				this.#onSnapshotResendCandidates,
				this.#snapshotAccessForChat(item.chatId),
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
			void (retained ? panel.restoreRetained(target ?? retained.target) : panel.restore(target)).catch(() => {
				if (this.#panels.get(item.surfaceId) === panel) this.markChatStale(item.chatId);
			});
		}
		for (const item of fullscreenHidden) {
			const panel = this.#panels.get(item.surfaceId);
			if (
				panel?.chatId === item.chatId &&
				!visible.some((entry) => entry.surfaceId === item.surfaceId)
			) {
				panel.prepareForHide();
			}
		}
		this.#visible = [...visible];
		for (const [chatId, minimumLimit] of snapshotLimitsByChat) {
			void this.loadChatSnapshot(chatId, minimumLimit > 0 ? { minimumLimit } : {}).catch(() => {
				this.markChatStale(chatId);
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
		void this.#visible;
		return this.#panels.get(surfaceId) ?? null;
	}

	isPanelVisible(surfaceId: ChatViewSurfaceId, chatId: string): boolean {
		void this.#visible;
		const panel = this.#panels.get(surfaceId);
		return panel?.chatId === chatId && panel.isPresentationVisible;
	}

	get composerPanel(): ConversationPanelRegistration | null {
		void this.#visible;
		const surfaceId = this.options.getComposerAnchorSurfaceId();
		const selectedChatId = this.options.getSelectedChatId();
		if (!surfaceId || !selectedChatId) return null;
		const panel = this.#panels.get(surfaceId);
		return panel?.chatId === selectedChatId && panel.isPresentationVisible ? panel : null;
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
			promise: this.#performChatSnapshotLoad(
				chatId,
				options,
				() => this.#snapshotLoads.get(chatId) === operation,
			).finally(() => {
				if (this.#snapshotLoads.get(chatId) === operation) this.#snapshotLoads.delete(chatId);
			}),
		};
		this.#snapshotLoads.set(chatId, operation);
		return operation.promise;
	}

	#snapshotAccessForChat(chatId: string) {
		return {
			load: (options: ChatLoadMessagesOptions) => this.loadChatSnapshot(chatId, options),
			wait: (signal: AbortSignal) => this.#waitForChatSnapshot(chatId, signal),
			canLoad: () => this.#hasAdmittedPanel(chatId),
			interrupted: () => this.markChatStale(chatId),
		};
	}

	async #waitForChatSnapshot(chatId: string, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		let pending = this.#snapshotLoads.get(chatId);
		while (pending) {
			await waitForSnapshot(pending.promise, signal);
			signal.throwIfAborted();
			pending = this.#snapshotLoads.get(chatId);
		}
	}

	async #performChatSnapshotLoad(
		chatId: string,
		options: ChatLoadMessagesOptions,
		isCurrent: () => boolean,
		retryAfterLoaderRemoval = true,
	): Promise<boolean> {
		const loader = [...this.#panels.values()].find(
			(panel) =>
				panel.chatId === chatId &&
				panel.isPresentationVisible &&
				panel.snapshotAdmission === 'admitted',
		);
		if (!loader) return false;
		const previousViews = new Map(
			[...this.#panels.values()]
				.filter((panel) => panel.chatId === chatId)
				.map((panel) => [panel, panel.transcript.transcriptViewId]),
		);
		const load = this.options.loadTranscriptSnapshot
			? this.options.loadTranscriptSnapshot(loader.transcript, chatId, options)
			: loader.transcript.loadMessages(chatId, options);
		await load.catch((error: unknown) => {
			if (isCurrent()) throw error;
		});
		if (!isCurrent()) return false;
		const loaderWasRemoved = this.#panels.get(loader.surfaceId) !== loader;
		if (loaderWasRemoved) {
			return retryAfterLoaderRemoval
				? this.#performChatSnapshotLoad(chatId, options, isCurrent, false)
				: false;
		}
		const cursor = this.options.cache.readAppliedCursor(chatId);
		if (!cursor || cursor.stale) {
			return false;
		}
		const currentPanels = [...this.#panels.values()].filter((panel) => panel.chatId === chatId);
		if (currentPanels.length === 0) return false;
		for (const panel of currentPanels) {
			const previousView = previousViews.get(panel) ?? panel.transcript.transcriptViewId;
			if (panel === loader || panel.transcript.installCachedSnapshot(chatId) === 'applied') {
				if (previousView && previousView !== panel.transcript.transcriptViewId) {
					panel.resetForViewReplacement();
				}
				panel.completeRecovery();
			} else {
				panel.markRecoveryRequired();
			}
		}
		return true;
	}

	#hasAdmittedPanel(chatId: string): boolean {
		return [...this.#panels.values()].some(
			(panel) =>
				panel.chatId === chatId &&
				panel.isPresentationVisible &&
				panel.snapshotAdmission === 'admitted',
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
		this.#reconnectReplays.set(chatId, {
			token,
			replayToken,
			replay,
			transcriptViewId,
			invalidated: false,
		});
		return token;
	}

	applyReconnectReplayPage(
		token: number,
		chatId: string,
		batch: TranscriptBufferedBatch,
	): TranscriptReplayApplyResult | 'stale' {
		const active = this.#reconnectReplays.get(chatId);
		if (!active || active.token !== token) return 'stale';
		if (active.invalidated) return 'gap-detected';
		return active.replay.applyPage(active.replayToken, chatId, batch);
	}

	finishReconnectReplay(
		token: number,
		chatId: string,
		throughOrdinal: number,
	): TranscriptReplayApplyResult | 'stale' {
		const active = this.#reconnectReplays.get(chatId);
		if (!active || active.token !== token) return 'stale';
		const result = active.invalidated
			? 'gap-detected'
			: active.replay.finish(active.replayToken, chatId);
		if (this.#reconnectReplays.get(chatId) === active) {
			this.#reconnectReplays.delete(chatId);
		}
		if (result !== 'applied') return result;
		const cursor = this.options.cache.readAppliedCursor(chatId);
		if (
			!cursor ||
			cursor.transcriptViewId !== active.transcriptViewId ||
			cursor.lastOrdinal < throughOrdinal
		) {
			return 'gap-detected';
		}
		this.options.cache.markValidated(chatId);
		for (const panel of this.#panels.values()) {
			if (
				panel.chatId === chatId &&
				panel.transcript.transcriptViewId === cursor.transcriptViewId &&
				panel.transcript.lastOrdinal === cursor.lastOrdinal
			) {
				panel.completeRecovery();
			}
		}
		return 'applied';
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
			this.#inactiveWindows.removeChat(batch.chatId);
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
			if (result !== 'applied') {
				panel.markRecoveryRequired();
				localRecoverySurfaceIds.push(panel.surfaceId);
			}
		}
		this.#inactiveWindows.applySharedCommit(commit, overlayMutation);
		return { kind: 'applied', localRecoverySurfaceIds };
	}

	hasInactiveWindow(chatId: string): boolean {
		return (
			this.#inactiveWindows.hasChat(chatId) ||
			[...this.#panels.values()].some(
				(panel) => panel.chatId === chatId && !panel.isPresentationVisible,
			)
		);
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
		this.#inactiveWindows.removeChat(chatId);
		this.#snapshotLoads.delete(chatId);
		for (const panel of this.#panels.values()) {
			if (panel.chatId !== chatId) continue;
			panel.transcript.invalidatePendingSnapshotLoad();
			if (!panel.isPresentationVisible) panel.resetForViewReplacement();
		}
		this.markChatStale(chatId);
		this.#applyOverlayMutation(chatId, this.options.overlays.resetForTranscriptReplacement(chatId));
		this.#deleteStoredSurfaceStateForChat(chatId);
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
		this.options.overlays.remove(chatId);
		this.options.lifecycle.remove(chatId);
	}

	markChatStale(chatId: string): void {
		const replay = this.#reconnectReplays.get(chatId);
		if (replay) {
			replay.replay.abort(replay.replayToken);
			replay.invalidated = true;
		}
		this.#inactiveWindows.removeChat(chatId);
		for (const panel of this.#panels.values()) {
			if (panel.chatId === chatId) panel.markRecoveryRequired();
		}
		this.options.cache.markStale(chatId);
	}

	destroy(): void {
		this.#inactiveWindows.clear();
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

	#desiredPanels(
		visible: readonly ConversationPanelDescriptor[],
		fullscreenHidden: readonly ConversationPanelDescriptor[],
	): ReadonlyMap<ChatViewSurfaceId, ConversationPanelDescriptor> {
		const desired = new Map(visible.map((item) => [item.surfaceId, item]));
		for (const item of fullscreenHidden) {
			const panel = this.#panels.get(item.surfaceId);
			if (
				!desired.has(item.surfaceId) &&
				panel?.chatId === item.chatId &&
				panel.canRetain(item.presentation)
			) {
				desired.set(item.surfaceId, item);
			}
		}
		return desired;
	}

	#needsSnapshot(panel: PanelRegistration): boolean {
		const cached = this.options.cache.readAppliedCursor(panel.chatId);
		return (
			panel.recoveryRequired ||
			panel.transcript.loadStatus === 'error' ||
			!cached ||
			cached.stale ||
			cached.transcriptViewId !== panel.transcript.transcriptViewId ||
			cached.lastOrdinal !== panel.transcript.lastOrdinal
		);
	}

	#restoreFreshCache(panel: PanelRegistration): void {
		const cached = this.options.cache.readAppliedCursor(panel.chatId);
		if (!cached || cached.stale || panel.recoveryRequired || !this.#needsSnapshot(panel)) return;
		const previousView = panel.transcript.transcriptViewId;
		if (panel.transcript.installCachedSnapshot(panel.chatId) !== 'applied') {
			panel.markRecoveryRequired();
		} else if (previousView && previousView !== panel.transcript.transcriptViewId) {
			panel.resetForViewReplacement();
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
