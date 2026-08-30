import { ActiveTranscriptState, type SharedTranscriptCommit } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ChatTranscriptApplyResult, ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ConversationFeedPresentationPort } from '$lib/chat/transcript/conversation-feed-presentation-port.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
import type { TranscriptPageDirection } from '$lib/chat/transcript/transcript-page-progress.js';
import type { OptimisticUserInput } from '$lib/chat/transcript/optimistic-user-input.js';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import {
	ConversationTranscriptOverlayStore,
	type ConversationTranscriptOverlayMutation,
} from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import type { ConversationLifecycleRegistry } from './conversation-lifecycle-registry.svelte.js';
import type { ConversationLifecycleState } from './conversation-lifecycle-state.svelte.js';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import type { VisibleChatPresentation } from '$lib/workspace/visible-presentations.js';

export interface CommittedTranscriptBatch {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly messages: TranscriptMessage[];
	readonly firstOrdinal: number;
	readonly lastOrdinal: number;
	readonly resendCandidates: ResendCandidate[];
	readonly noticeRevision: number;
}

export interface ConversationPanelScrollPort {
	readonly viewport: HTMLDivElement;
	noteUserScrollIntent(direction: TranscriptPageDirection | null): void;
	scrollByPixels(deltaY: number): void;
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
	prepareForInteractionLoss(): void;
	prepareForHide(): ConversationPanelRestoreTarget;
	restore(target: ConversationPanelRestoreTarget | null): Promise<void>;
	destroy(): void;
}

export interface ChatSurfaceTransfer {
	readonly from: ChatViewSurfaceId;
	readonly to: ChatViewSurfaceId;
	readonly chatId: string;
}

export interface ChatSurfaceTransferTransaction {
	commit(): void;
	abort(): void;
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

class PanelRegistration implements ConversationPanelRegistration {
	#surfaceId: ChatViewSurfaceId;
	#presentation: ConversationPanelPresentationPort | null = null;
	#lastTarget: ConversationPanelRestoreTarget = { kind: 'end' };
	#destroyed = false;

	readonly transcript: ActiveTranscriptState;
	readonly lifecycle: ConversationLifecycleState;
	readonly scroll: ConversationScrollController;

	constructor(
		surfaceId: ChatViewSurfaceId,
		readonly chatId: string,
		cache: ChatTranscriptCache,
		lifecycle: Pick<ConversationLifecycleRegistry, 'forChat'>,
	) {
		this.#surfaceId = surfaceId;
		this.transcript = new ActiveTranscriptState(cache);
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

	get surfaceId(): ChatViewSurfaceId {
		return this.#surfaceId;
	}

	attachPresentation(port: ConversationPanelPresentationPort): () => void {
		if (this.#destroyed) return () => {};
		this.#presentation = port;
		this.scroll.setViewportVisible(true);
		const binding = port;
		return () => {
			if (this.#presentation !== binding) return;
			this.#lastTarget = binding.captureRestoreTarget() ?? this.#lastTarget;
			binding.closeTransients();
			this.#presentation = null;
		};
	}

	prepareForInteractionLoss(): void {
		this.#presentation?.closeTransients();
	}

	prepareForHide(): ConversationPanelRestoreTarget {
		if (this.#presentation) {
			this.#lastTarget = this.#presentation.captureRestoreTarget() ?? this.#lastTarget;
			this.#presentation.closeTransients();
		}
		this.scroll.setViewportVisible(false);
		this.scroll.cancelNativeScroll();
		this.transcript.invalidatePendingHistoryLoad();
		this.transcript.invalidatePendingWindowNavigation();
		return this.#lastTarget;
	}

	async restore(target: ConversationPanelRestoreTarget | null): Promise<void> {
		if (this.#destroyed) return;
		this.#lastTarget = target ?? { kind: 'end' };
		const restored = this.transcript.activateChat(this.chatId);
		if (!restored || restored.stale) await this.transcript.loadMessages(this.chatId);
		if (this.#lastTarget.kind === 'end') {
			this.scroll.setPinnedToBottom(true);
			this.scroll.prepareInitialBottomRestore(this.chatId);
			return;
		}
		if (this.#lastTarget.transcriptViewId !== this.transcript.transcriptViewId) {
			this.#lastTarget = { kind: 'end' };
			this.scroll.setPinnedToBottom(true);
			this.scroll.prepareInitialBottomRestore(this.chatId);
			return;
		}
		this.scroll.setPinnedToBottom(false);
		await this.scroll.jumpToMessageRow({
			chatId: this.chatId,
			transcriptViewId: this.#lastTarget.transcriptViewId,
			rowId: `${this.#lastTarget.transcriptViewId}:${this.#lastTarget.ordinal}`,
		});
	}

	rekey(surfaceId: ChatViewSurfaceId): void {
		this.#surfaceId = surfaceId;
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.prepareForHide();
		this.#destroyed = true;
		this.#presentation = null;
		this.transcript.clearMessages();
	}
}

export class ConversationPanelRegistry {
	#panels = new Map<ChatViewSurfaceId, PanelRegistration>();
	#restoreTargets = new Map<ChatViewSurfaceId, StoredRestoreTarget>();
	#visible = $state.raw<readonly VisibleChatPresentation[]>([]);

	constructor(
		private readonly options: {
			cache: ChatTranscriptCache;
			lifecycle: Pick<ConversationLifecycleRegistry, 'forChat' | 'remove'>;
			overlays: ConversationTranscriptOverlayStore;
		},
	) {}

	get visiblePresentations(): readonly VisibleChatPresentation[] {
		return this.#visible;
	}

	reconcile(visible: readonly VisibleChatPresentation[]): void {
		const desired = new Map(visible.map((item) => [item.surfaceId, item]));
		for (const [surfaceId, panel] of this.#panels) {
			const next = desired.get(surfaceId);
			if (next?.chatId === panel.chatId) continue;
			this.#restoreTargets.set(surfaceId, {
				chatId: panel.chatId,
				target: panel.prepareForHide(),
			});
			panel.destroy();
			this.#panels.delete(surfaceId);
		}
		for (const item of visible) {
			if (this.#panels.has(item.surfaceId)) continue;
			const panel = new PanelRegistration(
				item.surfaceId,
				item.chatId,
				this.options.cache,
				this.options.lifecycle,
			);
			this.#panels.set(item.surfaceId, panel);
			const stored = this.#restoreTargets.get(item.surfaceId);
			const target = stored?.chatId === item.chatId ? stored.target : null;
			if (stored?.chatId !== item.chatId) this.#restoreTargets.delete(item.surfaceId);
			void panel.restore(target);
		}
		this.#visible = [...visible];
	}

	prepareSurfaceTransfers(
		transfers: readonly ChatSurfaceTransfer[],
	): ChatSurfaceTransferTransaction {
		const prepared = transfers.map((transfer) => {
			const panel = this.#panels.get(transfer.from);
			const hidden = this.#restoreTargets.get(transfer.from);
			if (panel && panel.chatId !== transfer.chatId) {
				throw new Error(`Chat panel transfer source mismatch: ${transfer.from}`);
			}
			if (hidden && hidden.chatId !== transfer.chatId) {
				throw new Error(`Chat panel restore transfer source mismatch: ${transfer.from}`);
			}
			if (!panel && !hidden) {
				throw new Error(`Chat panel transfer source is missing: ${transfer.from}`);
			}
			return { transfer, panel, hidden };
		});
		let settled = false;
		return {
			commit: () => {
				if (settled) return;
				settled = true;
				for (const { transfer, panel, hidden } of prepared) {
					const destination = this.#panels.get(transfer.to);
					if (destination && destination !== panel) destination.destroy();
					this.#panels.delete(transfer.to);
					this.#restoreTargets.delete(transfer.to);
					this.#panels.delete(transfer.from);
					this.#restoreTargets.delete(transfer.from);
					if (panel) {
						panel.rekey(transfer.to);
						this.#panels.set(transfer.to, panel);
					} else if (hidden) {
						this.#restoreTargets.set(transfer.to, hidden);
					}
				}
			},
			abort: () => {
				settled = true;
			},
		};
	}

	panel(surfaceId: ChatViewSurfaceId): ConversationPanelRegistration | null {
		return this.#panels.get(surfaceId) ?? null;
	}

	panelsForChat(chatId: string): readonly ConversationPanelRegistration[] {
		return [...this.#panels.values()].filter((panel) => panel.chatId === chatId);
	}

	currentPanel(surfaceId: string | null): ConversationPanelRegistration | null {
		if (!surfaceId) return null;
		return this.#panels.get(surfaceId as ChatViewSurfaceId) ?? null;
	}

	visibleChatIds(): readonly string[] {
		return [...new Set(this.#visible.map((item) => item.chatId))];
	}

	applyCommittedBatch(batch: CommittedTranscriptBatch): ConversationPanelBatchApplyResult {
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
			this.options.overlays.upsertOptimisticInput(
				chatId,
				input,
				cursor?.lastOrdinal ?? 0,
			),
		);
	}

	markOptimisticInputDelivered(chatId: string, clientMessageId: string): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.markOptimisticInputDelivered(chatId, clientMessageId),
		);
	}

	clearOptimisticInput(chatId: string, clientMessageId: string): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.clearOptimisticInput(chatId, clientMessageId),
		);
	}

	excludeResendCandidate(chatId: string, ordinal: number): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.excludeResendCandidate(chatId, ordinal),
		);
	}

	clearResendExclusions(chatId: string): void {
		this.#applyOverlayMutation(
			chatId,
			this.options.overlays.clearResendExclusions(chatId),
		);
	}

	handleViewReplacement(chatId: string): void {
		this.options.cache.remove(chatId);
		this.options.overlays.remove(chatId);
		for (const panel of this.#panels.values()) {
			if (panel.chatId === chatId) panel.transcript.clearMessages();
		}
		for (const [surfaceId, stored] of this.#restoreTargets) {
			if (stored.chatId === chatId) this.#restoreTargets.delete(surfaceId);
		}
	}

	removeChat(chatId: string): void {
		for (const [surfaceId, panel] of this.#panels) {
			if (panel.chatId !== chatId) continue;
			panel.destroy();
			this.#panels.delete(surfaceId);
		}
		for (const [surfaceId, stored] of this.#restoreTargets) {
			if (stored.chatId === chatId) this.#restoreTargets.delete(surfaceId);
		}
		this.options.cache.remove(chatId);
		this.options.overlays.remove(chatId);
		this.options.lifecycle.remove(chatId);
	}

	markChatStale(chatId: string): void {
		this.options.cache.markStale(chatId);
	}

	destroy(): void {
		for (const panel of this.#panels.values()) panel.destroy();
		this.#panels.clear();
		this.#restoreTargets.clear();
		this.#visible = [];
	}

	#applyOverlayMutation(chatId: string, mutation: ConversationTranscriptOverlayMutation): void {
		if (!mutation.feedStructureChanged) return;
		for (const panel of this.#panels.values()) {
			if (panel.chatId === chatId) panel.transcript.applySharedOverlayMutation(mutation);
		}
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
