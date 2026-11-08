import { SvelteMap } from 'svelte/reactivity';
import type {
	ActiveTranscriptState,
	ChatLoadMessagesOptions,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store.js';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { transcriptDisplayApi, type TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import type { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
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
import type { ResendCandidate } from '$shared/chat-view';
import { emptyAnnouncementOrdinals, emptyResponseClassOrdinals, type AnnouncementOrdinals, type ResponseClassOrdinals } from '$shared/transcript-display-events';
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
import { PanelRegistration } from './conversation-panel-registration.js';

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
	readonly metadata: Promise<boolean>;
	readonly promise: Promise<boolean>;
	readonly abort: AbortController;
	snapshot: DisplayOpenResponse | null;
	successor: Promise<boolean> | null;
	readonly projections: Map<ConversationPanelRegistration, Promise<unknown>>;
}

function waitForSnapshot(snapshot: Promise<unknown>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		void snapshot.then(() => resolve(), reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

export class ConversationPanelRegistry implements ChatSurfaceTransferPort {
	#panels = new Map<ChatViewSurfaceId, PanelRegistration>();
	#inactiveWindows = new InactiveTranscriptWindowStore();
	#restoreTargets = new Map<ChatViewSurfaceId, StoredRestoreTarget>();
	#pendingSurfaceTransfers = new Map<ChatViewSurfaceId, PendingSurfaceTransfer>();
	#surfaceTransferToken = 0;
	#snapshotLoads = new Map<string, SnapshotLoad>();
	#refreshGeneration = 0;
	#heads = new SvelteMap<string, { transcriptViewId: string; lastOrdinal: number }>();
	#opens = new SvelteMap<string, DisplayOpenResponse>();
	#serverInstanceId = $state('');
	#openListeners = new Set<(snapshot: DisplayOpenResponse) => void>();
	// Reconciliation updates this reactive revision after mutating the plain panel map.
	#visible = $state.raw<readonly ConversationPanelDescriptor[]>([]);
	#onOpen = (snapshot: DisplayOpenResponse): void => {
		const previous = this.#heads.get(snapshot.chat.id);
		this.#expireStatusNotices(snapshot.chat.id, snapshot.transcriptViewId, snapshot.sourceHead);
		if (previous && previous.transcriptViewId !== snapshot.transcriptViewId) {
			const committed = new Map(snapshot.submissions.flatMap(input => input.ordinal === null ? [] : [[input.clientMessageId, input.ordinal] as const]));
			const carried = this.options.overlays.viewFor(snapshot.chat.id)?.optimisticInputs.filter(input => committed.has(input.clientMessageId)) ?? [];
			this.#resetViewPresentation(snapshot.chat.id);
			for (const input of carried) this.options.overlays.upsertOptimisticInput(snapshot.chat.id,
				{ ...input, delivery: 'delivered' }, committed.get(input.clientMessageId)! - 1);
		}
		this.#opens.set(snapshot.chat.id, snapshot);
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
	get serverInstanceId(): string { return this.#serverInstanceId; }
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
			const panel: PanelRegistration = new PanelRegistration(
				item.surfaceId,
				item.chatId,
				item.snapshotAdmission,
				this.options.bodies,
				this.options.lifecycle,
				this.options.overlays,
				{
					load: (options, signal) => {
						void this.loadChatSnapshot(item.chatId, options).catch(() => {});
						return this.#waitForChatSnapshot(item.chatId, panel, signal);
					},
					wait: (signal) => this.#waitForChatSnapshot(item.chatId, panel, signal),
					// A retained transcript must not capture this scope's retired panel.
					represented: this.acknowledgeInput.bind(this, item.chatId),
				},
				retained?.transcript,
			);
			this.#panels.set(item.surfaceId, panel);
			const stored = this.#restoreTargets.get(item.surfaceId);
			let target = this.#inactiveWindows.takeRestoreTarget(item.surfaceId, item.chatId);
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

	async refreshChatSnapshot(chatId: string): Promise<boolean> {
		const generation = this.#refreshGeneration;
		const pending = this.#snapshotLoads.get(chatId);
		if (pending) {
			// A pre-reconnect response cannot account for notifications missed during the outage.
			await waitForSnapshot(pending.metadata, pending.abort.signal).catch(() => undefined);
			if (generation !== this.#refreshGeneration) return false;
			if (pending.abort.signal.aborted) return this.#snapshotLoads.get(chatId)?.promise ?? pending.successor ?? false;
			if (this.#snapshotLoads.get(chatId) === pending) {
				// Surface requests keep their own gates and reconcile the newly installed head independently.
				pending.abort.abort();
				this.#snapshotLoads.delete(chatId);
				return pending.successor = this.loadChatSnapshot(chatId);
			}
		}
		return this.loadChatSnapshot(chatId);
	}

	loadChatSnapshot(chatId: string, options: ChatLoadMessagesOptions = {}): Promise<boolean> {
		if (!this.#hasSnapshotDemand(chatId)) return Promise.resolve(false);
		const pending = this.#snapshotLoads.get(chatId);
		if (pending) {
			this.#projectSnapshot(chatId, pending);
			const purposeCovered = options.purpose === undefined || pending.purpose === options.purpose;
			if (purposeCovered) return pending.promise;
			return pending.metadata.then(() => {
				if (this.#snapshotLoads.get(chatId) === pending) {
					pending.abort.abort();
					this.#snapshotLoads.delete(chatId);
					return pending.successor = this.loadChatSnapshot(chatId, options);
				}
				return this.loadChatSnapshot(chatId, options);
			});
		}
		const metadata = Promise.resolve().then(() => this.#performChatSnapshotLoad(chatId, options, operation));
		const operation: SnapshotLoad = {
			purpose: options.purpose,
			metadata,
			abort: new AbortController(),
			snapshot: null,
			successor: null,
			projections: new Map(),
			promise: metadata.then(async opened => {
				if (!opened) return false;
				let projectedCount: number;
				do {
					this.#projectSnapshot(chatId, operation);
					projectedCount = operation.projections.size;
					await Promise.all(operation.projections.values());
				} while (this.#snapshotLoads.get(chatId) === operation && projectedCount !== operation.projections.size);
				return operation.successor ?? (this.#snapshotLoads.get(chatId) === operation && !operation.abort.signal.aborted);
			}).finally(() => {
				if (this.#snapshotLoads.get(chatId) === operation) this.#snapshotLoads.delete(chatId);
			}),
		};
		this.#snapshotLoads.set(chatId, operation);
		return operation.promise;
	}

	async #waitForChatSnapshot(chatId: string, panel: ConversationPanelRegistration, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		let pending = this.#snapshotLoads.get(chatId);
		while (pending) {
			const waiting = AbortSignal.any([signal, pending.abort.signal]);
			try {
				await waitForSnapshot(pending.metadata, waiting);
				const projection = pending.projections.get(panel);
				if (projection) await waitForSnapshot(projection, waiting);
			} catch (error) {
				if (!pending.abort.signal.aborted) throw error;
			}
			signal.throwIfAborted();
			const next = this.#snapshotLoads.get(chatId);
			if (next === pending) return;
			pending = next;
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
			this.#projectSnapshot(chatId, operation);
			return isCurrent();
		} catch (error) {
			if (!isCurrent() || !this.#hasSnapshotDemand(chatId)) return false;
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

	observeHead(chatId: string, transcriptViewId: string, lastOrdinal: number, responseTypes: ResponseClassOrdinals = emptyResponseClassOrdinals(), announcements: AnnouncementOrdinals = emptyAnnouncementOrdinals()): void {
		const previous = this.#heads.get(chatId);
		if (previous && previous.transcriptViewId !== transcriptViewId) this.handleViewReplacement(chatId);
		this.#expireStatusNotices(chatId, transcriptViewId, lastOrdinal);
		this.#heads.set(chatId, { transcriptViewId, lastOrdinal: previous?.transcriptViewId === transcriptViewId ? Math.max(previous.lastOrdinal, lastOrdinal) : lastOrdinal });
		for (const panel of this.panelsForChat(chatId)) panel.transcript.observeHead(transcriptViewId, lastOrdinal, responseTypes, announcements);
		this.#inactiveWindows.observeHead(chatId, transcriptViewId, lastOrdinal);
	}
	#expireStatusNotices(chatId: string, transcriptViewId: string, lastOrdinal: number): void {
		const previous = this.#heads.get(chatId);
		if (previous?.transcriptViewId === transcriptViewId && lastOrdinal > previous.lastOrdinal) {
			this.#applyOverlayMutation(chatId, this.options.overlays.clearStatusNotices(chatId));
		}
	}

	markChatDirty(chatId: string): void {
		for (const panel of this.panelsForChat(chatId)) panel.transcript.controller.ready();
	}
	cancelRefreshes(): void {
		++this.#refreshGeneration;
		for (const operation of this.#snapshotLoads.values()) operation.abort.abort();
		this.#snapshotLoads.clear();
		for (const panel of this.#panels.values()) panel.transcript.cancelOpen();
	}

	resetServerInstance(serverInstanceId: string): void {
		this.#adoptServerInstance(serverInstanceId);
	}
	#adoptServerInstance(serverInstanceId: string, openingChatId?: string): void {
		if (this.#serverInstanceId === serverInstanceId) return;
		const previous = this.#serverInstanceId;
		const targets = [...this.#panels.values()].map(panel => ({ panel, target: panel.captureRestoreTarget() }));
		this.#serverInstanceId = serverInstanceId;
		this.options.bodies.resetInstance(serverInstanceId);
		if (!previous) return;
		this.options.overlays.resetResendCandidates();
		for (const [chatId, operation] of this.#snapshotLoads) {
			if (chatId === openingChatId) continue;
			operation.abort.abort();
			this.#snapshotLoads.delete(chatId);
		}
		this.#inactiveWindows.evictWindows();
		this.#opens.clear();
		// Retains view identity for replacement cleanup without trusting the previous process's frontier.
		for (const [chatId, head] of this.#heads) this.#heads.set(chatId, { ...head, lastOrdinal: 0 });
		for (const { panel, target } of targets) {
			// Restoration joins the discovering open; awaiting it here would deadlock admission.
			void panel.restore(target).catch(() => this.markChatStale(panel.chatId));
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
		this.#snapshotLoads.get(chatId)?.abort.abort();
		this.#snapshotLoads.delete(chatId);
		this.#heads.delete(chatId);
		this.#opens.delete(chatId);
		this.#resetViewPresentation(chatId);
		void this.loadChatSnapshot(chatId).catch(() => this.markChatStale(chatId));
	}

	#resetViewPresentation(chatId: string): void {
		for (const panel of this.panelsForChat(chatId)) panel.transcript.clearMessages();
		this.#inactiveWindows.removeChat(chatId);
		this.markChatDirty(chatId);
		this.#applyOverlayMutation(chatId, this.options.overlays.resetForTranscriptReplacement(chatId));
		this.#deleteStoredSurfaceStateForChat(chatId);
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
		this.#inactiveWindows.evictChatWindows(chatId);
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
		this.#inactiveWindows.takeRestoreTarget(transfer.sourceSurfaceId, item.chatId);
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

		return this.#inactiveWindows.restoreTarget(transfer.sourceSurfaceId, transfer.chatId) ?? { kind: 'end' };
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
