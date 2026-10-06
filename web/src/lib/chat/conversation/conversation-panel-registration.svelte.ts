import {
	ActiveTranscriptState,
	type ChatLoadMessagesOptions,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
import type { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import type { ConversationLifecycleRegistry } from './conversation-lifecycle-registry.svelte.js';
import type { ConversationLifecycleState } from './conversation-lifecycle-state.svelte.js';
import type { ResendCandidate } from '$shared/chat-view';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import type {
	TranscriptRowNavigationResult,
	TranscriptRowTarget,
} from '$lib/chat/transcript/transcript-row-navigation.js';
import type { UserMessageNavigatorSelectionResult } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
import type {
	ConversationPanelRegistration,
	ConversationPanelPresentationPort,
	ConversationPanelSnapshotAdmission,
} from './conversation-panel-registry.svelte.js';

export class PanelRegistration implements ConversationPanelRegistration {
	#presentation: ConversationPanelPresentationPort | null = null;
	#lastTarget: ConversationPanelRestoreTarget = { kind: 'end' };
	#restoreEpoch = 0;
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
		cache: ChatTranscriptCache,
		lifecycle: Pick<ConversationLifecycleRegistry, 'forChat'>,
		overlays: ConversationTranscriptOverlayStore,
		onSnapshotResendCandidates: (chatId: string, candidates: readonly ResendCandidate[]) => void,
		private readonly snapshots: {
			load(options: ChatLoadMessagesOptions): Promise<boolean>;
			wait(signal: AbortSignal): Promise<void>;
		},
		retainedTranscript?: ActiveTranscriptState,
	) {
		this.#snapshotAdmission = snapshotAdmission;
		this.transcript = retainedTranscript ?? new ActiveTranscriptState(cache, overlays.forChat(chatId), {
			onSnapshotResendCandidates,
		});
		if (!retainedTranscript) this.transcript.activateChat(chatId);
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
		if (port.getViewport()) this.#presentationReady?.();
		this.resumePendingRestore();
		return () => {
			if (this.#presentation !== port) return;
			this.#rowNavigation?.abort();
			this.#lastTarget = port.captureRestoreTarget() ?? this.#lastTarget;
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
		if (this.#presentation) {
			this.#lastTarget = this.#presentation.captureRestoreTarget() ?? this.#lastTarget;
		}
		return this.#lastTarget;
	}

	completeInitialBottomRestore(): void {
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
		const restoreEpoch = this.#beginRestore(target);
		const restored = this.transcript.activateChat(this.chatId);
		if (!restored || restored.stale) {
			const loadOptions = { minimumLimit: restored?.count ?? 0 };
			await this.snapshots.load(loadOptions);
		}
		await this.#finishRestore(restoreEpoch);
	}

	async restoreRetained(target: ConversationPanelRestoreTarget): Promise<void> {
		if (this.#destroyed) return;
		const restoreEpoch = this.#beginRestore(target);
		await this.#finishRestore(restoreEpoch);
	}

	#beginRestore(target: ConversationPanelRestoreTarget | null): number {
		this.#rowNavigation?.abort();
		const restoreEpoch = ++this.#restoreEpoch;
		this.#readyRestoreEpoch = null;
		this.#lastTarget = target ?? { kind: 'end' };
		return restoreEpoch;
	}

	async #finishRestore(restoreEpoch: number): Promise<void> {
		if (this.#destroyed || restoreEpoch !== this.#restoreEpoch) return;
		this.#readyRestoreEpoch = restoreEpoch;
		await this.#applyPendingRestore();
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
		++this.#restoreEpoch;
		this.#readyRestoreEpoch = null;
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
		this.#lifetime.abort();
		this.#presentation = null;
		this.transcript.clearMessages();
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
