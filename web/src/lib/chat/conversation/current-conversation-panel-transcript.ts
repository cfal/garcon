import type { ChatMessage } from '$shared/chat-types';
import type { UserRowSummary } from '$shared/transcript-display-auxiliary';
import type { TranscriptMessage } from '$shared/chat-view';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations.js';
import {
	ActiveTranscriptState,
	type ActiveTranscriptPort,
	type ChatCursor,
	type ChatLoadMessagesOptions,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import type { OptimisticUserInput } from '$lib/chat/transcript/optimistic-user-input.js';
import type { ConversationPanelRegistry } from './conversation-panel-registry.svelte.js';

export class CurrentConversationPanelTranscript implements ActiveTranscriptPort {
	readonly #fallback;
	readonly #optimisticChatIds = new Map<string, string>();

	constructor(
		private readonly options: {
			panels: ConversationPanelRegistry;
			getSelectedChatId: () => string | null;
		},
	) {
		this.#fallback = new ActiveTranscriptState();
	}
	get bodyStore() { return this.#transcript().bodyStore; }
	get serverInstanceId(): string { return this.openSnapshot?.serverInstanceId ?? ''; }

	get activeChatId(): string | null {
		return this.#current()?.chatId ?? this.#fallback.activeChatId;
	}

	set activeChatId(chatId: string | null) {
		if (!this.#current()) this.#fallback.activeChatId = chatId;
	}

	get entries(): readonly TranscriptMessage[] {
		return this.#transcript().entries;
	}

	get resendCandidates(): readonly UserRowSummary[] {
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
		return this.#current()?.transcript.transcriptViewId ?? this.openSnapshot?.transcriptViewId ?? '';
	}

	get lastOrdinal(): number {
		const chatId = this.activeChatId;
		return this.#current()?.transcript.lastOrdinal ?? (chatId ? this.options.panels.knownHead(chatId)?.lastOrdinal : 0) ?? 0;
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
		return { transcriptViewId: this.transcriptViewId, lastOrdinal: this.lastOrdinal };
	}
	forkSelection(ordinal: number) { return this.#transcript().forkSelection(ordinal); }

	getCursorForChat(chatId: string): ChatCursor {
		const panel = this.#panelForChat(chatId);
		if (panel) return panel.transcript.getCursor();
		const cursor = this.options.panels.knownHead(chatId);
		return {
			transcriptViewId: cursor?.transcriptViewId ?? '',
			lastOrdinal: cursor?.lastOrdinal ?? 0,
		};
	}

	getKnownHeadForChat(chatId: string): ChatCursor {
		return this.getCursorForChat(chatId);
	}

	setResendCandidates(candidates: readonly UserRowSummary[]): void {
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
		if (!this.#panelForChat(chatId) && this.options.getSelectedChatId() === chatId) {
			if (this.#fallback.activeChatId !== chatId) this.#fallback.activateChat(chatId);
			this.#fallback.beginOpen();
		}
		try {
			await this.options.panels.loadChatSnapshot(chatId, options);
			return this.#panelForChat(chatId)?.transcript.chatMessages ?? [];
		} finally {
			if (this.#fallback.activeChatId === chatId) this.#fallback.invalidatePendingLoads();
		}
	}

	appendLocalNotice(noticeType: LocalNoticeType, content: string): void {
		const chatId = this.options.getSelectedChatId();
		if (chatId) this.options.panels.appendLocalNotice(chatId, noticeType, content);
	}

	async recoverViewReplacement(chatId: string, previousViewId: string): Promise<void> {
		const currentViewId = this.options.panels.knownHead(chatId)?.transcriptViewId;
		// A delivered replacement or a later view already owns the presentation.
		if (currentViewId && currentViewId !== previousViewId) return;
		this.discardChat(chatId);
		this.options.panels.handleViewReplacement(chatId);
		for (const panel of this.options.panels.panelsForChat(chatId)) panel.transcript.clearMessages();
		if (!this.hasMountedPresentation(chatId)) {
			if (this.options.getSelectedChatId() !== chatId) return;
			this.#fallback.activateChat(chatId);
		}
		await this.loadMessages(chatId, { purpose: 'activation' });
	}

	appendLocalNoticeForChat(chatId: string, noticeType: LocalNoticeType, content: string): void {
		this.options.panels.appendLocalNotice(chatId, noticeType, content);
	}

	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void {
		this.options.panels.appendServerNotice(chatId, noticeType, content);
	}

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

	activateChat(chatId: string | null): void {
		if (chatId && this.#current()?.chatId === chatId) return;
		this.#fallback.activateChat(chatId || null);
	}

	get openSnapshot() {
		const chatId = this.activeChatId;
		return this.#current()?.transcript.openSnapshot ?? (chatId ? this.options.panels.openSnapshot(chatId) : null);
	}
	get bodyCertificate() { return this.#transcript().display.window?.certificate ?? null; }
	destroy(): void { this.#fallback.dispose(); this.#optimisticChatIds.clear(); }

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
