import type { ChatProcessingPhase } from '$shared/chat-types';
import type { ConversationLifecyclePort } from './conversation-lifecycle-registry.svelte.js';
import type {
	LoadingStatus,
	LoadingStatusEntry,
	StoppingSnapshot,
} from './conversation-lifecycle-state.svelte.js';

export class CurrentConversationLifecycle {
	constructor(
		private readonly options: {
			lifecycles: ConversationLifecyclePort;
			getSelectedChatId: () => string | null;
		},
	) {}

	get currentChatId(): string | null {
		return this.options.getSelectedChatId();
	}

	get loadingStatus(): LoadingStatus | null {
		const chatId = this.currentChatId;
		if (!chatId) return null;
		return this.options.lifecycles.get(chatId)?.loadingStatus ?? null;
	}

	beginTurn(chatId: string): void {
		this.options.lifecycles.beginTurn(chatId);
	}

	beginStopping(chatId: string, requestId: string): StoppingSnapshot | null {
		return this.options.lifecycles.beginStopping(chatId, requestId);
	}

	clearTurnStatus(chatId: string): void {
		this.options.lifecycles.clearTurnStatus(chatId);
	}

	restoreStopping(chatId: string, requestId: string, snapshot: StoppingSnapshot | null): void {
		this.options.lifecycles.restoreStopping(chatId, requestId, snapshot);
	}

	applyProcessingPhase(chatId: string, phase: ChatProcessingPhase | null): void {
		this.options.lifecycles.applyProcessingPhase(chatId, phase);
	}

	markTurnRunning(chatId?: string | null): void {
		if (chatId) this.options.lifecycles.forChat(chatId).markTurnRunning(chatId);
	}

	setCurrentChatId(_chatId: string | null): void {}

	setLoadingStatus(status: LoadingStatus | null): void {
		const chatId = this.currentChatId;
		if (chatId) this.options.lifecycles.forChat(chatId).setLoadingStatus(status);
	}

	pushLoadingStatus(entry: LoadingStatusEntry): void {
		const chatId = this.currentChatId;
		if (chatId) this.options.lifecycles.forChat(chatId).pushLoadingStatus(entry);
	}

	popLoadingStatus(id: string): void {
		const chatId = this.currentChatId;
		if (chatId) this.options.lifecycles.forChat(chatId).popLoadingStatus(id);
	}

	setIsSystemChatChange(_value: boolean): void {}
}
