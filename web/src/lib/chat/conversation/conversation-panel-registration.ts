import { ActiveTranscriptState, type ChatLoadMessagesOptions } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { DisplayBodyStore } from '$lib/chat/transcript/display-body-store.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
import type { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import type { ConversationLifecycleRegistry } from './conversation-lifecycle-registry.svelte.js';
import type { ConversationLifecycleState } from './conversation-lifecycle-state.svelte.js';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import type { TranscriptRowNavigationResult, TranscriptRowTarget } from '$lib/chat/transcript/transcript-row-navigation.js';
import type { UserMessageNavigatorSelectionResult } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
import type { ConversationPanelPresentationPort, ConversationPanelRegistration, ConversationPanelSnapshotAdmission } from './conversation-panel-registry.svelte.js';

export class PanelRegistration implements ConversationPanelRegistration {
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
			load(options: ChatLoadMessagesOptions, signal: AbortSignal): Promise<void>;
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
			await this.snapshots.load({}, this.#lifetime.signal);
		} finally { await this.#finishRestore(restoreEpoch); }
	}

	async restoreRetained(target: ConversationPanelRestoreTarget): Promise<void> {
		if (this.#destroyed) return;
		const restoreEpoch = this.#beginRestore(target);
		this.transcript.controller.activate();
		try { await this.snapshots.load({ purpose: 'activation' }, this.#lifetime.signal); }
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
					const result = await this.transcript.navigateToRow(target, combined, isCurrent);
					await this.snapshots.wait(combined);
					if (!isCurrent()) return 'cancelled';
					if (this.transcript.transcriptViewId !== target.transcriptViewId) return 'view-changed';
					return result;
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
		if (!this.transcript.transcriptViewId) return;
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
