import type { ChatMessage } from '$shared/chat-types';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations.js';
import {
	ActiveTranscriptState,
	type ActiveTranscriptPort,
	type ChatCursor,
	type ChatLoadMessagesOptions,
	type ChatRestoreResult,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import type { OptimisticUserInput } from '$lib/chat/transcript/optimistic-user-input.js';
import { echoedClientMessageIds } from '$lib/chat/transcript/transcript-row-projection.js';
import type { ConversationPanelRegistry } from './conversation-panel-registry.svelte.js';

export class CurrentConversationPanelTranscript implements ActiveTranscriptPort {
	readonly transcriptCache;
	readonly #fallback;
	readonly #optimisticChatIds = new Map<string, string>();

	constructor(
		private readonly options: {
			panels: ConversationPanelRegistry;
			getSelectedChatId: () => string | null;
		},
	) {
		this.transcriptCache = options.panels.transcriptCache;
		this.#fallback = new ActiveTranscriptState(this.transcriptCache);
	}

	get activeChatId(): string | null {
		return this.#current()?.chatId ?? this.#fallback.activeChatId;
	}

	set activeChatId(chatId: string | null) {
		if (!this.#current()) this.#fallback.activeChatId = chatId;
	}

	get entries(): readonly TranscriptMessage[] {
		return this.#transcript().entries;
	}

	get resendCandidates(): readonly ResendCandidate[] {
		const chatId = this.options.getSelectedChatId();
		return chatId ? (this.options.panels.overlayFor(chatId)?.includedResendCandidates ?? []) : [];
	}

	get excludedResendOrdinals(): readonly number[] {
		const chatId = this.options.getSelectedChatId();
		return chatId ? (this.options.panels.overlayFor(chatId)?.excludedResendOrdinals ?? []) : [];
	}

	get chatMessages(): ChatMessage[] {
		return this.#transcript().chatMessages;
	}

	get displayMessages(): ChatMessage[] {
		return this.#transcript().displayMessages;
	}

	get displayRows() {
		return this.#transcript().displayRows;
	}

	get transcriptViewId(): string {
		return this.#transcript().transcriptViewId;
	}

	get lastOrdinal(): number {
		return this.#transcript().lastOrdinal;
	}

	get hasEarlierMessages(): boolean {
		return this.#transcript().hasEarlierMessages;
	}

	get hasLaterMessages(): boolean {
		return this.#transcript().hasLaterMessages;
	}

	get isLoadingMessages(): boolean {
		return this.#transcript().isLoadingMessages;
	}

	get loadStatus() {
		return this.#transcript().loadStatus;
	}

	get feedMutationClock(): ConversationFeedMutationClock {
		return this.#transcript().feedMutationClock;
	}

	get isUserScrolledUp(): boolean {
		return this.#transcript().isUserScrolledUp;
	}

	set isUserScrolledUp(value: boolean) {
		this.#transcript().isUserScrolledUp = value;
	}

	getCursor(): ChatCursor {
		return this.#transcript().getCursor();
	}

	getCursorForChat(chatId: string): ChatCursor {
		const panel = this.#panelForChat(chatId);
		if (panel) return panel.transcript.getCursor();
		if (this.#fallback.activeChatId === chatId) return this.#fallback.getCursor();
		const cursor = this.transcriptCache.readAppliedCursor(chatId);
		return {
			transcriptViewId: cursor?.transcriptViewId ?? '',
			lastOrdinal: cursor?.lastOrdinal ?? 0,
		};
	}

	applyMessages(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
		resendCandidates: ResendCandidate[] = [],
	): 'applied' | 'view-changed' | 'gap-detected' {
		const result = this.options.panels.applyCommittedBatch({
			chatId,
			transcriptViewId,
			messages,
			firstOrdinal,
			lastOrdinal,
			resendCandidates,
			noticeRevision: this.options.panels.noticeRevisionFor(chatId),
		});
		if (result.kind === 'applied') {
			for (const clientMessageId of echoedClientMessageIds(messages)) {
				if (this.#optimisticChatIds.get(clientMessageId) === chatId) {
					this.#optimisticChatIds.delete(clientMessageId);
				}
			}
			return result.localRecoverySurfaceIds.length === 0 ? 'applied' : 'gap-detected';
		}
		return result.outcome.status === 'view-changed' ? 'view-changed' : 'gap-detected';
	}

	setResendCandidates(candidates: readonly ResendCandidate[]): void {
		const chatId = this.options.getSelectedChatId();
		if (chatId) this.options.panels.replaceResendCandidates(chatId, candidates);
	}

	excludeResendCandidate(ordinal: number): void {
		const chatId = this.options.getSelectedChatId();
		if (chatId) this.options.panels.excludeResendCandidate(chatId, ordinal);
	}

	clearResendExclusions(): void {
		const chatId = this.options.getSelectedChatId();
		if (chatId) this.options.panels.clearResendExclusions(chatId);
	}

	async loadMessages(chatId: string, options?: ChatLoadMessagesOptions): Promise<ChatMessage[]> {
		const panel = this.#panelForChat(chatId);
		if (!panel) return this.#fallback.loadMessages(chatId, options);
		await this.options.panels.loadChatSnapshot(chatId, options);
		return this.#panelForChat(chatId)?.transcript.chatMessages ?? panel.transcript.chatMessages;
	}

	appendLocalNotice(noticeType: LocalNoticeType, content: string): void {
		const chatId = this.options.getSelectedChatId();
		if (chatId) this.options.panels.appendLocalNotice(chatId, noticeType, content);
	}

	appendLocalNoticeForChat(chatId: string, noticeType: LocalNoticeType, content: string): void {
		this.options.panels.appendLocalNotice(chatId, noticeType, content);
	}

	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void {
		this.options.panels.appendServerNotice(chatId, noticeType, content);
	}

	discardServerNotices(_chatId: string): void {}

	clearLocalNotices(): void {
		const chatId = this.options.getSelectedChatId();
		if (chatId) this.options.panels.clearNotices(chatId);
	}

	clearLocalNoticesForChat(chatId: string, throughRevision?: number): void {
		this.options.panels.clearNotices(chatId, throughRevision);
	}

	noticeRevisionForChat(chatId: string): number {
		return this.options.panels.noticeRevisionFor(chatId);
	}

	upsertOptimisticUserInput(input: OptimisticUserInput): void {
		this.#optimisticChatIds.set(input.clientMessageId, input.chatId);
		this.options.panels.upsertOptimisticInput(input.chatId, input);
	}

	markOptimisticUserInputDelivered(clientMessageId: string): void {
		const chatId = this.#optimisticChatIds.get(clientMessageId);
		if (!chatId) return;
		this.#optimisticChatIds.delete(clientMessageId);
		this.options.panels.markOptimisticInputDelivered(chatId, clientMessageId);
	}

	clearOptimisticUserInput(clientMessageId: string): void {
		const chatId = this.#optimisticChatIds.get(clientMessageId);
		if (!chatId) return;
		this.#optimisticChatIds.delete(clientMessageId);
		this.options.panels.clearOptimisticInput(chatId, clientMessageId);
	}

	discardChat(chatId: string): void {
		for (const [clientMessageId, optimisticChatId] of this.#optimisticChatIds) {
			if (optimisticChatId === chatId) this.#optimisticChatIds.delete(clientMessageId);
		}
		if (this.#fallback.activeChatId === chatId) this.#fallback.activateChat(null);
	}

	hasMountedPresentation(chatId: string): boolean {
		return this.options.panels.panelsForChat(chatId).length > 0;
	}

	activateChat(chatId: string | null): ChatRestoreResult | null {
		if (!chatId) return this.#fallback.activateChat(null);
		if (this.#current()?.chatId === chatId) return null;
		return this.#fallback.activateChat(chatId);
	}

	revealAllLoadedMessages(): void {
		this.#transcript().revealAllLoadedMessages();
	}

	#current() {
		return this.options.panels.composerPanel;
	}

	#panelForChat(chatId: string) {
		const current = this.#current();
		if (current?.chatId === chatId) return current;
		return this.options.panels.panelsForChat(chatId)[0] ?? null;
	}

	#transcript(): ActiveTranscriptState {
		return this.#current()?.transcript ?? this.#fallback;
	}
}
