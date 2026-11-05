import { SvelteMap } from 'svelte/reactivity';
import {
	ActiveTranscriptState,
	type ChatLoadMessagesOptions,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store.js';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { transcriptDisplayApi, type TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
import {
	InactiveTranscriptWindowStore,
	type InactiveTranscriptWindow,
} from '$lib/chat/transcript/inactive-transcript-window-store.js';
import type { OptimisticUserInput } from '$lib/chat/transcript/optimistic-user-input.js';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import {
	ConversationTranscriptOverlayStore,
	type ConversationTranscriptOverlayMutation,
} from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import type { ConversationLifecycleRegistry } from './conversation-lifecycle-registry.svelte.js';
import type { ConversationLifecycleState } from './conversation-lifecycle-state.svelte.js';
import type { UserRowSummary } from '$shared/transcript-display-auxiliary';
import { emptyResponseClassOrdinals, type ResponseClassOrdinals } from '$shared/transcript-display-events';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import type { VisibleChatPresentation } from '$lib/workspace/visible-presentations.js';
import type {
	ChatSurfaceTransfer,
	ChatSurfaceTransferPort,
} from '$lib/workspace/chat-surface-transfer.js';
import type { WorkspacePublication } from '$lib/workspace/workspace-commit.js';
import type {
	TranscriptRowNavigationResult,
	TranscriptRowTarget,
} from '$lib/chat/transcript/transcript-row-navigation.js';
import type { UserMessageNavigatorSelectionResult } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';

export type ConversationPanelSnapshotAdmission = 'deferred' | 'admitted';

export interface ConversationPanelDescriptor extends VisibleChatPresentation {
	readonly snapshotAdmission: ConversationPanelSnapshotAdmission;
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

interface StoredRestoreTarget {
	readonly chatId: string;
	readonly target: ConversationPanelRestoreTarget;
}

interface PendingSurfaceTransfer extends StoredRestoreTarget {
	readonly token: number;
	readonly sourceSurfaceId: ChatViewSurfaceId;
}

interface SnapshotLoad {
	readonly purpose: ChatLoadMessagesOptions['purpose'];
	readonly promise: Promise<boolean>;
	readonly abort: AbortController;
	snapshot: DisplayOpenResponse | null;
	readonly projections: Map<ConversationPanelRegistration, Promise<unknown>>;
}

class PanelRegistration implements ConversationPanelRegistration {
	#presentation: ConversationPanelPresentationPort | null = null;
	#lastTarget: ConversationPanelRestoreTarget = { kind: 'end' };
	#restoreEpoch = 0;
	#restoreLoading = false;
	#releaseRestoreAnchor: (() => void) | null = null;
	#readyRestoreEpoch: number | null = null;
	#applyingRestoreEpoch: number | null = null;
	#restoreResumeRequested = false;
	#destroyed = false;
	#snapshotAdmission: ConversationPanelSnapshotAdmission;
	#rowNavigation: AbortController | null = null;
	#lifetime = new AbortController();
	#presentationReady: (() => void) | null = null;

	readonly transcript: ActiveTranscriptState;
	readonly lifecycle: ConversationLifecycleState;
	readonly scroll: ConversationScrollController;

	constructor(
		readonly surfaceId: ChatViewSurfaceId,
		readonly chatId: string,
		snapshotAdmission: ConversationPanelSnapshotAdmission,
		bodies: DisplayBodyStore,
		lifecycle: Pick<ConversationLifecycleRegistry, 'forChat'>,
		overlays: ConversationTranscriptOverlayStore,
		private readonly snapshots: {
			load(options: ChatLoadMessagesOptions): Promise<boolean>;
			wait(signal: AbortSignal): Promise<void>;
			represented(view: string, clientMessageId: string, ordinal: number): void;
		},
		retainedTranscript?: ActiveTranscriptState,
	) {
		this.#snapshotAdmission = snapshotAdmission;
		this.transcript = retainedTranscript ?? new ActiveTranscriptState(bodies, overlays.forChat(chatId), undefined, snapshots.represented);
		if (!retainedTranscript) this.transcript.activateChat(chatId);
		this.lifecycle = lifecycle.forChat(chatId);
		this.scroll = new ConversationScrollController({
			getScrollContainer: () => this.#presentation?.getScrollContainer() ?? null,
			getViewport: () => this.#presentation?.getViewport() ?? null,
			getQueueContainer: () => this.#presentation?.getQueueContainer(),
			chatState: this.transcript,
			getChatId: () => (this.#destroyed ? null : this.chatId),
			onUserScrollIntent: () => this.#cancelRestore(),
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
		if (port.getViewport()) this.#presentationReady?.();
		this.resumePendingRestore();
		return () => {
			if (this.#presentation !== port) return;
			this.#rowNavigation?.abort();
			this.captureRestoreTarget();
			port.closeTransients();
			this.#presentation = null;
		};
	}

	resumePendingRestore(): void {
		if (this.#presentation?.getViewport()) this.#presentationReady?.();
		if (this.#applyingRestoreEpoch !== null) {
			this.#restoreResumeRequested = true;
			return;
		}
		void this.#applyPendingRestore();
	}

	prepareForInteractionLoss(): void {
		this.#rowNavigation?.abort();
		this.#presentation?.closeTransients();
	}

	captureRestoreTarget(): ConversationPanelRestoreTarget {
		if (this.#presentation && (this.#lastTarget.kind === 'end'
			|| !this.#restoreLoading && this.#readyRestoreEpoch === null)) {
			this.#lastTarget = this.#presentation.captureRestoreTarget() ?? this.#lastTarget;
		}
		return this.#lastTarget;
	}

	completeInitialBottomRestore(): void {
		if (this.#restoreLoading) return;
		this.scroll.completeInitialBottomRestore(() => this.snapshots.wait(this.#lifetime.signal));
	}

	prepareForHide(): ConversationPanelRestoreTarget {
		this.#rowNavigation?.abort();
		const target = this.captureRestoreTarget();
		this.#presentation?.closeTransients();
		this.scroll.setViewportVisible(false);
		this.scroll.cancelNativeScroll();
		this.transcript.invalidatePendingHistoryLoad();
		this.transcript.invalidatePendingWindowNavigation();
		return target;
	}

	async restore(target: ConversationPanelRestoreTarget | null): Promise<void> {
		if (this.#destroyed) return;
		this.transcript.activateChat(this.chatId);
		const restoreEpoch = this.#beginRestore(target);
		try {
			await this.snapshots.load({});
		} finally { await this.#finishRestore(restoreEpoch); }
	}

	async restoreRetained(target: ConversationPanelRestoreTarget): Promise<void> {
		if (this.#destroyed) return;
		const restoreEpoch = this.#beginRestore(target);
		this.transcript.controller.activate();
		try { await this.snapshots.load({ purpose: 'activation' }); }
		finally { await this.#finishRestore(restoreEpoch); }
	}

	#beginRestore(target: ConversationPanelRestoreTarget | null): number {
		this.#rowNavigation?.abort();
		this.#releaseRestoreAnchor?.();
		this.#releaseRestoreAnchor = null;
		const restoreEpoch = ++this.#restoreEpoch;
		this.#restoreLoading = true;
		this.#readyRestoreEpoch = null;
		this.#lastTarget = target ?? { kind: 'end' };
		if (this.#lastTarget.kind === 'end') this.#prepareInitialBottomRestore();
		else {
			this.scroll.setPinnedToBottom(false);
			this.prepareDisplayRefresh();
		}
		return restoreEpoch;
	}

	prepareDisplayRefresh(): void {
		if ((!this.#restoreLoading && this.#readyRestoreEpoch === null) || this.#lastTarget.kind === 'end'
			|| this.#lastTarget.transcriptViewId !== this.transcript.transcriptViewId) return;
		this.#releaseRestoreAnchor?.();
		this.#releaseRestoreAnchor = this.transcript.controller.holdReadingAnchor(this.#lastTarget.ordinal);
	}

	async #finishRestore(restoreEpoch: number): Promise<void> {
		if (this.#destroyed || restoreEpoch !== this.#restoreEpoch) return;
		this.#restoreLoading = false;
		this.#readyRestoreEpoch = restoreEpoch;
		await this.#applyPendingRestore();
	}

	#cancelRestore(): void {
		++this.#restoreEpoch;
		this.#restoreLoading = false;
		this.#readyRestoreEpoch = null;
		this.#releaseRestoreAnchor?.();
		this.#releaseRestoreAnchor = null;
	}

	async navigateToTranscriptRow(
		target: TranscriptRowTarget,
		signal: AbortSignal,
		ownsNavigation: () => boolean,
	): Promise<TranscriptRowNavigationResult> {
		this.#rowNavigation?.abort();
		const operation = new AbortController();
		this.#rowNavigation = operation;
		const combined = AbortSignal.any([signal, operation.signal]);
		const current = () => !this.#destroyed && this.#rowNavigation === operation && ownsNavigation();
		this.#cancelRestore();
		try {
			const result = await this.scroll.navigateToTranscriptRow(
				target,
				combined,
				async (isCurrent) => {
					await this.#waitForPresentation(combined);
					if (!isCurrent()) return 'cancelled';
					await this.snapshots.wait(combined);
					if (!isCurrent()) return 'cancelled';
					return this.transcript.navigateToRow(target, combined, isCurrent);
				},
				current,
			);
			if (combined.aborted || !current()) return 'cancelled';
			await this.snapshots.wait(combined);
			if (combined.aborted || !current()) return 'cancelled';
			if (
				this.transcript.transcriptViewId &&
				this.transcript.transcriptViewId !== target.transcriptViewId
			)
				return 'view-changed';
			return result;
		} catch (error) {
			if (combined.aborted || !current()) return 'cancelled';
			throw error;
		} finally {
			if (this.#rowNavigation === operation) this.#rowNavigation = null;
		}
	}

	#waitForPresentation(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.#presentation?.getViewport()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const finish = () => {
				if (this.#presentationReady === finish) this.#presentationReady = null;
				signal.removeEventListener('abort', finish);
				if (signal.aborted) reject(signal.reason);
				else resolve();
			};
			this.#presentationReady = finish;
			signal.addEventListener('abort', finish, { once: true });
		});
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
			const target = this.#lastTarget;
			const row = {
				chatId: this.chatId,
				transcriptViewId: target.transcriptViewId,
				rowId: `${target.transcriptViewId}:${target.ordinal}`,
			};
			let result: UserMessageNavigatorSelectionResult;
			if (target.kind === 'group-summary') {
				result = await this.scroll.jumpToMessageRow(row, {
					viewportOffset: target.viewportOffset,
					presentation: 'group-summary',
				});
			} else {
				result = await this.scroll.jumpToMessageRow(row, {
					viewportOffset: target.viewportOffset,
				});
			}
			if (
				(result === 'completed' || result === 'unavailable'
					&& this.transcript.display.phase === 'available' && this.#presentation?.getViewport()?.isReady()) &&
				restoreEpoch === this.#restoreEpoch &&
				restoreEpoch === this.#readyRestoreEpoch
			) {
				this.#readyRestoreEpoch = null;
				this.#releaseRestoreAnchor?.();
				this.#releaseRestoreAnchor = null;
			}
		} finally {
			if (this.#applyingRestoreEpoch === restoreEpoch) this.#applyingRestoreEpoch = null;
			if (this.#restoreResumeRequested) {
				this.#restoreResumeRequested = false;
				void this.#applyPendingRestore();
			}
		}
	}

	#prepareInitialBottomRestore(): void {
		this.#releaseRestoreAnchor?.();
		this.#releaseRestoreAnchor = null;
		this.#readyRestoreEpoch = null;
		this.scroll.setPinnedToBottom(true);
		this.scroll.prepareInitialBottomRestore(this.chatId);
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.prepareForHide();
		this.#destroyed = true;
		this.#lifetime.abort();
		this.#presentation = null;
		this.transcript.dispose();
	}

	detachTranscript(): ActiveTranscriptState | null {
		if (this.#destroyed) return null;
		this.prepareForHide();
		if (!this.transcript.suspendForParking()) return null;
		this.#destroyed = true;
		this.#lifetime.abort();
		this.#presentation = null;
		return this.transcript;
	}
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
	#heads = new SvelteMap<string, { transcriptViewId: string; lastOrdinal: number }>();
	#opens = new SvelteMap<string, DisplayOpenResponse>();
	#serverInstanceId = '';
	#openListeners = new Set<(snapshot: DisplayOpenResponse) => void>();
	// Reconciliation updates this reactive revision after mutating the plain panel map.
	#visible = $state.raw<readonly ConversationPanelDescriptor[]>([]);
	#onOpen = (snapshot: DisplayOpenResponse): void => {
		this.#opens.set(snapshot.chat.id, snapshot);
		const previous = this.#heads.get(snapshot.chat.id);
		this.#heads.set(snapshot.chat.id, { transcriptViewId: snapshot.transcriptViewId,
			lastOrdinal: previous?.transcriptViewId === snapshot.transcriptViewId ? Math.max(previous.lastOrdinal, snapshot.sourceHead) : snapshot.sourceHead });
		for (const submission of snapshot.submissions) if (submission.ordinal !== null) {
			this.acknowledgeInput(snapshot.chat.id, snapshot.transcriptViewId, submission.clientMessageId, submission.ordinal);
		}
		this.options.onOpen?.(snapshot);
		for (const listener of this.#openListeners) listener(snapshot);
	};

	constructor(
		private readonly options: {
			bodies: DisplayBodyStore;
			onOpen?: (snapshot: DisplayOpenResponse) => void;
			lifecycle: Pick<ConversationLifecycleRegistry, 'forChat' | 'remove'>;
			overlays: ConversationTranscriptOverlayStore;
			getComposerAnchorSurfaceId(): ChatViewSurfaceId | null;
			getSelectedChatId(): string | null;
			retainInactiveWindows?: () => boolean;
			openTranscript?: TranscriptDisplayApi['open'];
		},
	) {}

	get bodyStore(): DisplayBodyStore { return this.options.bodies; }
	knownHead(chatId: string) { return this.#heads.get(chatId) ?? null; }
	openSnapshot(chatId: string) { return this.#opens.get(chatId) ?? null; }
	observeOpenSnapshots(listener: (snapshot: DisplayOpenResponse) => void): () => void {
		this.#openListeners.add(listener);
		for (const snapshot of this.#opens.values()) listener(snapshot);
		return () => this.#openListeners.delete(listener);
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

	reconcile(visible: readonly ConversationPanelDescriptor[]): void {
		const desired = new Map(visible.map((item) => [item.surfaceId, item]));
		const admittedChatIds = new Set<string>();
		const retainInactive = this.options.retainInactiveWindows?.() ?? true;
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
				this.options.bodies,
				this.options.lifecycle,
				this.options.overlays,
				{
					load: (options) => this.loadChatSnapshot(item.chatId, options),
					wait: (signal) => this.#waitForChatSnapshot(item.chatId, signal),
					// A retained transcript must not capture this scope's retired panel.
					represented: this.acknowledgeInput.bind(this, item.chatId),
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
			void (retained ? panel.restoreRetained(target ?? retained.target) : panel.restore(target)).catch(() => {
				if (this.#panels.get(item.surfaceId) === panel) this.markChatStale(item.chatId);
			});
		}
		this.#visible = [...visible];
		for (const chatId of admittedChatIds) {
			void this.loadChatSnapshot(chatId, { purpose: 'activation' }).catch(() => {
				this.markChatDirty(chatId);
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
		if (!this.#hasSnapshotDemand(chatId)) return Promise.resolve(false);
		const pending = this.#snapshotLoads.get(chatId);
		if (pending) {
			this.#projectSnapshot(chatId, pending);
			const purposeCovered = options.purpose === undefined || pending.purpose === options.purpose;
			if (purposeCovered) return pending.promise;
			return pending.promise.then(() => this.loadChatSnapshot(chatId, options));
		}
		const operation: SnapshotLoad = {
			purpose: options.purpose,
			abort: new AbortController(),
			snapshot: null,
			projections: new Map(),
			promise: Promise.resolve().then(() => this.#performChatSnapshotLoad(chatId, options, operation)).finally(() => {
				if (this.#snapshotLoads.get(chatId) === operation) this.#snapshotLoads.delete(chatId);
			}),
		};
		this.#snapshotLoads.set(chatId, operation);
		return operation.promise;
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
		operation: SnapshotLoad,
	): Promise<boolean> {
		const isCurrent = () => this.#snapshotLoads.get(chatId) === operation && !operation.abort.signal.aborted;
		if (!isCurrent() || !this.#hasSnapshotDemand(chatId)) return false;
		for (const panel of this.panelsForChat(chatId)) panel.transcript.beginOpen();
		try {
			const requestedInstance = this.#serverInstanceId;
			const snapshot = await (this.options.openTranscript ?? transcriptDisplayApi.open)({ chatId,
				reason: options.purpose === 'activation' ? 'activate' : 'reconnect',
				outstandingClientMessageIds: (this.options.overlays.viewFor(chatId)?.optimisticInputs ?? []).map(input => input.clientMessageId).slice(0, 32),
			}, operation.abort.signal);
			if (!isCurrent() || !this.#hasSnapshotDemand(chatId)) return false;
			if (snapshot.chat.id !== chatId) throw new Error('Foreign display open');
			if (requestedInstance !== this.#serverInstanceId && snapshot.serverInstanceId !== this.#serverInstanceId) {
				return this.#performChatSnapshotLoad(chatId, options, operation);
			}
			this.#adoptServerInstance(snapshot.serverInstanceId, chatId);
			this.#onOpen(snapshot);
			operation.snapshot = snapshot;
			let projectedCount: number;
			do {
				this.#projectSnapshot(chatId, operation);
				projectedCount = operation.projections.size;
				await Promise.all(operation.projections.values());
			} while (isCurrent() && projectedCount !== operation.projections.size);
			return isCurrent();
		} catch (error) {
			if (!isCurrent()) return false;
			for (const panel of this.panelsForChat(chatId)) panel.transcript.failOpen(error);
			throw error;
		}
	}

	#projectSnapshot(chatId: string, operation: SnapshotLoad): void {
		const snapshot = operation.snapshot;
		if (!snapshot || operation.abort.signal.aborted || this.#snapshotLoads.get(chatId) !== operation) return;
		for (const panel of this.#panels.values()) {
			if (panel.chatId !== chatId || operation.projections.has(panel)) continue;
			panel.transcript.installOpen(snapshot);
			panel.transcript.observeHead(snapshot.transcriptViewId, this.#heads.get(chatId)!.lastOrdinal);
			panel.prepareDisplayRefresh();
			operation.projections.set(panel, panel.transcript.controller.refresh());
		}
	}

	#hasSnapshotDemand(chatId: string): boolean {
		const panels = [...this.#panels.values()].filter(panel => panel.chatId === chatId);
		return panels.some(panel => panel.snapshotAdmission === 'admitted')
			|| panels.length === 0 && this.options.getSelectedChatId() === chatId;
	}

	visibleChatIds(): readonly string[] {
		return [...new Set(this.#visible.map((item) => item.chatId))];
	}

	observeHead(chatId: string, transcriptViewId: string, lastOrdinal: number, responseTypes: ResponseClassOrdinals = emptyResponseClassOrdinals()): void {
		const previous = this.#heads.get(chatId);
		if (previous && previous.transcriptViewId !== transcriptViewId) this.handleViewReplacement(chatId);
		this.#heads.set(chatId, { transcriptViewId, lastOrdinal: previous?.transcriptViewId === transcriptViewId ? Math.max(previous.lastOrdinal, lastOrdinal) : lastOrdinal });
		for (const panel of this.panelsForChat(chatId)) panel.transcript.observeHead(transcriptViewId, lastOrdinal, responseTypes);
		this.#inactiveWindows.observeHead(chatId, transcriptViewId, lastOrdinal);
	}

	markChatDirty(chatId: string): void {
		for (const panel of this.panelsForChat(chatId)) panel.transcript.controller.ready();
	}
	cancelRefreshes(): void {
		for (const operation of this.#snapshotLoads.values()) operation.abort.abort();
		this.#snapshotLoads.clear();
		for (const panel of this.#panels.values()) panel.transcript.invalidatePendingLoads();
	}

	resetServerInstance(serverInstanceId: string): void {
		this.#adoptServerInstance(serverInstanceId);
	}
	#adoptServerInstance(serverInstanceId: string, openingChatId?: string): void {
		if (this.#serverInstanceId === serverInstanceId) return;
		const previous = this.#serverInstanceId;
		this.#serverInstanceId = serverInstanceId;
		this.options.bodies.resetInstance(serverInstanceId);
		if (!previous) return;
		for (const [chatId, operation] of this.#snapshotLoads) {
			if (chatId === openingChatId) continue;
			operation.abort.abort();
			this.#snapshotLoads.delete(chatId);
		}
		this.#inactiveWindows.clear();
		this.#opens.clear();
		this.#heads.clear();
		for (const panel of this.#panels.values()) panel.transcript.clearMessages();
		if (openingChatId) for (const chatId of this.visibleChatIds()) {
			if (chatId !== openingChatId) void this.loadChatSnapshot(chatId).catch(() => this.markChatStale(chatId));
		}
	}

	appendLocalNotice(chatId: string, noticeType: LocalNoticeType, content: string): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.appendLocalNotice(chatId, noticeType, content),
		);
	}

	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void {
		const head = this.#heads.get(chatId);
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.appendServerNotice(chatId, noticeType, content, head && this.#serverInstanceId ? {
				serverInstanceId: this.#serverInstanceId, transcriptViewId: head.transcriptViewId, ordinal: head.lastOrdinal,
			} : undefined),
		);
	}

	upsertOptimisticInput(chatId: string, input: OptimisticUserInput): void {
		const cursor = this.#heads.get(chatId);
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
	acknowledgeInput(chatId: string, view: string, clientMessageId: string, ordinal: number): void {
		const overlay = this.options.overlays.viewFor(chatId);
		const input = overlay?.optimisticInputs.find(input => input.clientMessageId === clientMessageId);
		if (!input) return;
		const after = overlay?.optimisticAfterOrdinals.get(clientMessageId) ?? 0;
		this.#applyOverlayMutation(chatId, this.options.overlays.advanceOptimisticAnchors(chatId, clientMessageId, ordinal));
		const transcripts = [...this.panelsForChat(chatId).map(panel => panel.transcript), ...this.#inactiveWindows.transcriptsForChat(chatId)];
		if (!transcripts.length) { this.markOptimisticInputDelivered(chatId, clientMessageId); return; }
		for (const transcript of transcripts) {
			transcript.acknowledgeInput(view, input, ordinal, after);
		}
		const represented = transcripts.some(transcript => transcript.display.window?.certificate.transcriptViewId === view
			&& transcript.display.window.items.some(item => item.kind === 'row' && item.ordinal === ordinal));
		if (represented) this.#applyOverlayMutation(chatId, this.options.overlays.acknowledgeInput(chatId, clientMessageId, ordinal));
		else this.markOptimisticInputDelivered(chatId, clientMessageId);
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

	replaceResendCandidates(chatId: string, candidates: readonly UserRowSummary[]): void {
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
		this.#snapshotLoads.get(chatId)?.abort.abort();
		this.#snapshotLoads.delete(chatId);
		this.#heads.delete(chatId);
		this.#opens.delete(chatId);
		for (const panel of this.panelsForChat(chatId)) panel.transcript.clearMessages();
		this.#inactiveWindows.removeChat(chatId);
		this.markChatDirty(chatId);
		this.#applyOverlayMutation(chatId, this.options.overlays.resetForTranscriptReplacement(chatId));
		this.#deleteStoredSurfaceStateForChat(chatId);
		void this.loadChatSnapshot(chatId).catch(() => this.markChatStale(chatId));
	}

	removeChat(chatId: string): void {
		this.#snapshotLoads.get(chatId)?.abort.abort();
		this.#snapshotLoads.delete(chatId);
		this.#inactiveWindows.removeChat(chatId);
		for (const [surfaceId, panel] of this.#panels) {
			if (panel.chatId !== chatId) continue;
			panel.destroy();
			this.#panels.delete(surfaceId);
		}
		this.#deleteStoredSurfaceStateForChat(chatId);
		this.#heads.delete(chatId);
		this.#opens.delete(chatId);
		this.options.overlays.remove(chatId);
		this.options.lifecycle.remove(chatId);
	}

	markChatStale(chatId: string): void {
		this.#inactiveWindows.removeChat(chatId);
		this.markChatDirty(chatId);
	}

	destroy(): void {
		this.cancelRefreshes();
		this.#inactiveWindows.clear();

		for (const panel of this.#panels.values()) panel.destroy();
		this.#panels.clear();
		this.#restoreTargets.clear();
		this.#pendingSurfaceTransfers.clear();
		this.#snapshotLoads.clear();
		this.#heads.clear();
		this.#opens.clear();
		this.#openListeners.clear();
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

}
