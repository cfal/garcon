import { UserMessage } from '$shared/chat-types';
import type { ChatDisplayRow } from './active-transcript-state.svelte.js';

export interface UserMessageNavigatorItem {
	id: string;
	seq?: number;
	content: string;
	timestamp: string;
	attachmentCount: number;
}

export interface UserMessageNavigatorTarget {
	chatId: string;
	generationId: string;
	rowId: string;
}

export type UserMessageNavigatorLoadError = 'older-page-failed';
export type UserMessageNavigatorSelectionError = 'target-unavailable';

export interface UserMessageNavigatorTranscriptPort {
	readonly activeChatId: string | null;
	readonly generationId: string;
	readonly displayRows: readonly ChatDisplayRow[];
	readonly hasMoreMessages: boolean;
	readonly isLoadingMessages: boolean;
	revealAllLoadedMessages(): void;
}

export interface UserMessageNavigatorOptions {
	transcript: UserMessageNavigatorTranscriptPort;
	getSelectedChatId: () => string | null;
	loadOlderMessages: (chatId: string) => Promise<boolean>;
	jumpToRow: (target: UserMessageNavigatorTarget) => Promise<boolean>;
}

export class UserMessageNavigatorController {
	open = $state(false);
	openedChatId = $state<string | null>(null);
	openedGenerationId = $state<string | null>(null);
	isLoadingOlder = $state(false);
	loadError = $state<UserMessageNavigatorLoadError | null>(null);
	selectionError = $state<UserMessageNavigatorSelectionError | null>(null);
	#lifecycleEpoch = 0;

	#items = $derived.by<UserMessageNavigatorItem[]>(() =>
		this.options.transcript.displayRows
			.flatMap((row) => {
				if (row.kind !== 'message' || !(row.message instanceof UserMessage)) return [];
				return [
					{
						id: row.id,
						seq: row.seq,
						content: row.message.content,
						timestamp: row.message.timestamp,
						attachmentCount: row.message.images?.length ?? 0,
					},
				];
			})
			.reverse(),
	);

	constructor(private readonly options: UserMessageNavigatorOptions) {}

	get items(): readonly UserMessageNavigatorItem[] {
		return this.#items;
	}

	get hasMore(): boolean {
		return this.open && this.options.transcript.hasMoreMessages;
	}

	get isInitialLoading(): boolean {
		return (
			this.open && (this.openedGenerationId === null || this.options.transcript.isLoadingMessages)
		);
	}

	openForActiveChat(): void {
		const chatId = this.options.getSelectedChatId();
		const generationId = this.options.transcript.generationId;
		if (!chatId || this.options.transcript.activeChatId !== chatId) return;

		this.#lifecycleEpoch += 1;
		this.openedChatId = chatId;
		this.openedGenerationId = generationId || null;
		this.isLoadingOlder = false;
		this.loadError = null;
		this.selectionError = null;
		this.open = true;
	}

	close(): void {
		this.#lifecycleEpoch += 1;
		this.open = false;
		this.#clearIdentity();
	}

	reconcileActiveTranscript(chatId: string | null, generationId: string): void {
		if (!this.open) return;
		if (chatId !== this.openedChatId) {
			this.close();
			return;
		}
		if (this.openedGenerationId === null) {
			if (generationId) this.openedGenerationId = generationId;
			return;
		}
		if (generationId !== this.openedGenerationId) this.close();
	}

	async loadOlder(): Promise<void> {
		const chatId = this.openedChatId;
		const generationId = this.openedGenerationId;
		const lifecycleEpoch = this.#lifecycleEpoch;
		if (
			!this.open ||
			!chatId ||
			!generationId ||
			this.isLoadingOlder ||
			!this.options.transcript.hasMoreMessages
		) {
			return;
		}

		this.isLoadingOlder = true;
		this.loadError = null;
		try {
			const loaded = await this.options.loadOlderMessages(chatId);
			if (!this.#matchesOpenTranscript(chatId, generationId, lifecycleEpoch)) return;
			if (!loaded && this.options.transcript.hasMoreMessages) {
				this.loadError = 'older-page-failed';
			}
		} finally {
			if (this.#matchesOpenTranscript(chatId, generationId, lifecycleEpoch)) {
				this.isLoadingOlder = false;
			}
		}
	}

	async retryLoadOlder(): Promise<void> {
		this.loadError = null;
		await this.loadOlder();
	}

	async select(item: UserMessageNavigatorItem): Promise<void> {
		const target = this.#targetFor(item.id);
		if (!target) return;
		const lifecycleEpoch = this.#lifecycleEpoch;

		this.selectionError = null;
		this.options.transcript.revealAllLoadedMessages();
		this.open = false;

		const jumped = await this.options.jumpToRow(target);
		if (lifecycleEpoch !== this.#lifecycleEpoch) return;
		if (jumped || !this.#matchesActiveTranscript(target.chatId, target.generationId)) {
			this.#clearIdentity();
			return;
		}

		this.selectionError = 'target-unavailable';
		this.open = true;
	}

	#targetFor(rowId: string): UserMessageNavigatorTarget | null {
		const chatId = this.openedChatId;
		const generationId = this.openedGenerationId;
		if (!this.open || !chatId || !generationId) return null;
		if (!this.#matchesActiveTranscript(chatId, generationId)) return null;
		return { chatId, generationId, rowId };
	}

	#matchesOpenTranscript(chatId: string, generationId: string, lifecycleEpoch: number): boolean {
		return (
			this.#lifecycleEpoch === lifecycleEpoch &&
			this.open &&
			this.openedChatId === chatId &&
			this.openedGenerationId === generationId &&
			this.#matchesActiveTranscript(chatId, generationId)
		);
	}

	#matchesActiveTranscript(chatId: string, generationId: string): boolean {
		return (
			this.options.getSelectedChatId() === chatId &&
			this.options.transcript.activeChatId === chatId &&
			this.options.transcript.generationId === generationId
		);
	}

	#clearIdentity(): void {
		this.openedChatId = null;
		this.openedGenerationId = null;
		this.isLoadingOlder = false;
		this.loadError = null;
		this.selectionError = null;
	}
}
