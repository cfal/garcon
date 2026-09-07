import { UserMessage } from '$shared/chat-types';
import type { UserMessagePresentation } from '$shared/chat-types';
import type { ChatDisplayRow, ChatLoadStatus } from './active-transcript-state.svelte.js';
import type { TranscriptPageLoadResult } from './transcript-page-progress.js';

export interface UserMessageNavigatorItem {
	id: string;
	ordinal?: number;
	content: string;
	timestamp: string;
	attachmentCount: number;
	presentation?: UserMessagePresentation;
}

export interface UserMessageNavigatorTarget {
	chatId: string;
	transcriptViewId: string;
	rowId: string;
}

export type UserMessageNavigatorLoadError = 'older-page-failed';
export type UserMessageNavigatorInitialLoadError = 'initial-load-failed';
export type UserMessageNavigatorSelectionError = 'target-unavailable';
export type UserMessageNavigatorSelectionResult = 'completed' | 'cancelled' | 'unavailable';
export type UserMessageNavigatorCommand = () => void;
export type UserMessageNavigatorRegistration = UserMessageNavigatorCommand | null;

export interface UserMessageNavigatorTranscriptPort {
	readonly activeChatId: string | null;
	readonly transcriptViewId: string;
	readonly displayRows: readonly ChatDisplayRow[];
	readonly hasEarlierMessages: boolean;
	readonly isLoadingMessages: boolean;
	readonly hasLaterMessages: boolean;
	readonly loadStatus: ChatLoadStatus;
	revealAllLoadedMessages(): void;
}

export interface UserMessageNavigatorOptions {
	transcript: UserMessageNavigatorTranscriptPort;
	getSelectedChatId: () => string | null;
	reloadTranscript: (chatId: string) => Promise<void>;
	restoreLatestTranscript: (chatId: string) => Promise<boolean>;
	loadOlderMessages: (chatId: string) => Promise<TranscriptPageLoadResult>;
	jumpToRow: (target: UserMessageNavigatorTarget) => Promise<UserMessageNavigatorSelectionResult>;
}

export interface UserMessageNavigatorDialogController {
	readonly open: boolean;
	readonly items: readonly UserMessageNavigatorItem[];
	readonly hasMore: boolean;
	readonly isInitialLoading: boolean;
	readonly initialLoadError: UserMessageNavigatorInitialLoadError | null;
	readonly isLoadingOlder: boolean;
	readonly loadError: UserMessageNavigatorLoadError | null;
	readonly selectionError: UserMessageNavigatorSelectionError | null;
	close(): void;
	retryInitialLoad(): Promise<void>;
	loadOlder(): Promise<void>;
	retryLoadOlder(): Promise<void>;
	select(item: UserMessageNavigatorItem): Promise<void>;
}

export class UserMessageNavigatorController implements UserMessageNavigatorDialogController {
	open = $state(false);
	openedChatId = $state<string | null>(null);
	openedTranscriptViewId = $state<string | null>(null);
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
						ordinal: row.ordinal,
						content: row.message.content,
						timestamp: row.message.timestamp,
						attachmentCount: row.message.images?.length ?? 0,
						...(row.message.presentation === undefined
							? {}
							: { presentation: row.message.presentation }),
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
		return this.open && this.options.transcript.hasEarlierMessages;
	}

	get isInitialLoading(): boolean {
		return this.open
			&& this.openedTranscriptViewId === null
			&& this.options.transcript.isLoadingMessages;
	}

	get initialLoadError(): UserMessageNavigatorInitialLoadError | null {
		return this.open &&
			this.openedTranscriptViewId === null &&
			!this.options.transcript.isLoadingMessages &&
			this.options.transcript.loadStatus === 'error'
			? 'initial-load-failed'
			: null;
	}

	async openForActiveChat(): Promise<void> {
		const chatId = this.options.getSelectedChatId();
		if (!chatId || this.options.transcript.activeChatId !== chatId) return;

		const lifecycleEpoch = ++this.#lifecycleEpoch;
		if (this.options.transcript.hasLaterMessages) {
			const restored = await this.options.restoreLatestTranscript(chatId);
			if (
				!restored ||
				lifecycleEpoch !== this.#lifecycleEpoch ||
				this.options.getSelectedChatId() !== chatId ||
				this.options.transcript.activeChatId !== chatId
			) {
				return;
			}
		}

		const transcriptViewId = this.options.transcript.transcriptViewId;
		this.openedChatId = chatId;
		this.openedTranscriptViewId = transcriptViewId || null;
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

	reconcileActiveTranscript(chatId: string | null, transcriptViewId: string): void {
		if (!this.open) return;
		if (chatId !== this.openedChatId) {
			this.close();
			return;
		}
		if (this.openedTranscriptViewId === null) {
			if (transcriptViewId) this.openedTranscriptViewId = transcriptViewId;
			return;
		}
		if (transcriptViewId !== this.openedTranscriptViewId) this.close();
	}

	async retryInitialLoad(): Promise<void> {
		const chatId = this.openedChatId;
		if (
			!this.open ||
			!chatId ||
			this.openedTranscriptViewId !== null ||
			this.options.transcript.isLoadingMessages
		) {
			return;
		}

		await this.options.reloadTranscript(chatId);
	}

	async loadOlder(): Promise<void> {
		const chatId = this.openedChatId;
		const transcriptViewId = this.openedTranscriptViewId;
		const lifecycleEpoch = this.#lifecycleEpoch;
		if (
			!this.open ||
			!chatId ||
			!transcriptViewId ||
			this.isLoadingOlder ||
			!this.options.transcript.hasEarlierMessages
		) {
			return;
		}

		this.isLoadingOlder = true;
		this.loadError = null;
		try {
			const result = await this.options.loadOlderMessages(chatId);
			if (!this.#matchesOpenTranscript(chatId, transcriptViewId, lifecycleEpoch)) return;
			if (result === 'failed') {
				this.loadError = 'older-page-failed';
			}
		} finally {
			if (this.#matchesOpenTranscript(chatId, transcriptViewId, lifecycleEpoch)) {
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
		const lifecycleEpoch = ++this.#lifecycleEpoch;

		this.isLoadingOlder = false;
		this.selectionError = null;
		this.options.transcript.revealAllLoadedMessages();
		this.open = false;

		const result = await this.options.jumpToRow(target);
		if (lifecycleEpoch !== this.#lifecycleEpoch) return;
		if (
			result !== 'unavailable' ||
			!this.#matchesActiveTranscript(target.chatId, target.transcriptViewId)
		) {
			this.#clearIdentity();
			return;
		}

		this.selectionError = 'target-unavailable';
		this.open = true;
	}

	#targetFor(rowId: string): UserMessageNavigatorTarget | null {
		const chatId = this.openedChatId;
		const transcriptViewId = this.openedTranscriptViewId ?? this.options.transcript.transcriptViewId;
		if (!this.open || !chatId) return null;
		if (!this.#matchesActiveTranscript(chatId, transcriptViewId)) return null;
		return { chatId, transcriptViewId, rowId };
	}

	#matchesOpenTranscript(
		chatId: string,
		transcriptViewId: string,
		lifecycleEpoch: number,
	): boolean {
		return (
			this.#lifecycleEpoch === lifecycleEpoch &&
			this.open &&
			this.openedChatId === chatId &&
			this.openedTranscriptViewId === transcriptViewId &&
			this.#matchesActiveTranscript(chatId, transcriptViewId)
		);
	}

	#matchesActiveTranscript(chatId: string, transcriptViewId: string): boolean {
		return (
			this.options.getSelectedChatId() === chatId &&
			this.options.transcript.activeChatId === chatId &&
			this.options.transcript.transcriptViewId === transcriptViewId
		);
	}

	#clearIdentity(): void {
		this.openedChatId = null;
		this.openedTranscriptViewId = null;
		this.isLoadingOlder = false;
		this.loadError = null;
		this.selectionError = null;
	}
}
