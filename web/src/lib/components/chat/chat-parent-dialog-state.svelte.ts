import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { ChatParentDialogTarget } from './chat-action-dialogs-state.svelte';
import { eligibleParentChats, matchParentChats, typedParentId } from './chat-parent-candidates';

interface ChatParentDialogOptions {
	readonly target: ChatParentDialogTarget | null;
	readonly chats: readonly ChatSessionRecord[];
	readonly isConnected: boolean;
	onConfirm: (chatId: string, parentChatId: string | null) => Promise<void>;
	onClose: () => void;
}

type ParentChoice = { kind: 'unset' } | { kind: 'chat'; chatId: string } | { kind: 'clear' };

export class ChatParentDialogState {
	choice = $state<ParentChoice>({ kind: 'unset' });
	query = $state('');
	submitting = $state(false);
	errorMessage = $state<string | null>(null);
	suggestionsOpen = $state(true);
	highlightedId = $state<string | null>(null);

	child = $derived.by(() =>
		this.options.chats.find((chat) => chat.id === this.options.target?.chatId),
	);
	currentParentId = $derived(this.child?.parentChatId ?? null);
	currentTitle = $derived.by(
		() => this.options.chats.find((chat) => chat.id === this.currentParentId)?.title,
	);
	#eligible = $derived.by(() =>
		eligibleParentChats(this.options.chats, this.options.target?.chatId ?? ''),
	);
	suggestions = $derived(matchParentChats(this.#eligible, this.query));
	activeSuggestion = $derived(
		this.suggestionsOpen
			? this.suggestions.find((chat) => chat.id === this.highlightedId)
			: undefined,
	);
	selected = $derived.by(() => {
		if (this.choice.kind !== 'chat') return undefined;
		const { chatId } = this.choice;
		return this.options.chats.find((chat) => chat.id === chatId);
	});
	#proposedId = $derived.by(() => {
		switch (this.choice.kind) {
			case 'clear':
				return null;
			case 'chat':
				return this.choice.chatId;
			case 'unset':
				return typedParentId(this.query);
		}
	});
	get canSubmit(): boolean {
		return (
			this.child !== undefined &&
			this.child.status !== 'draft' &&
			this.options.isConnected &&
			!this.submitting &&
			this.#proposedId !== undefined
		);
	}

	constructor(private readonly options: ChatParentDialogOptions) {}

	reset(): void {
		this.query = '';
		this.choice = { kind: 'unset' };
		this.submitting = false;
		this.errorMessage = null;
		this.suggestionsOpen = true;
		this.highlightedId = null;
	}

	editQuery(): void {
		this.choice = { kind: 'unset' };
		this.highlightedId = null;
		this.suggestionsOpen = true;
		this.errorMessage = null;
	}

	select(chat: ChatSessionRecord): void {
		if (this.submitting) return;
		this.choice = { kind: 'chat', chatId: chat.id };
		this.query = chat.id;
		this.suggestionsOpen = false;
		this.highlightedId = null;
		this.errorMessage = null;
	}

	clearParent(): void {
		this.choice = { kind: 'clear' };
		this.query = '';
		this.suggestionsOpen = false;
		this.errorMessage = null;
	}

	moveHighlight(key: 'ArrowDown' | 'ArrowUp'): void {
		this.suggestionsOpen = true;
		if (this.suggestions.length === 0) {
			this.highlightedId = null;
			return;
		}
		const current = this.suggestions.findIndex((chat) => chat.id === this.highlightedId);
		let next: number;
		if (key === 'ArrowDown') {
			next = (current + 1) % this.suggestions.length;
		} else if (current <= 0) {
			next = this.suggestions.length - 1;
		} else {
			next = current - 1;
		}
		this.highlightedId = this.suggestions[next]?.id ?? null;
	}

	async submit(): Promise<void> {
		const target = this.options.target;
		const parentId = this.#proposedId;
		if (!this.canSubmit || !target || parentId === undefined) return;
		this.submitting = true;
		this.errorMessage = null;
		try {
			await this.options.onConfirm(target.chatId, parentId);
			if (this.options.target === target) this.options.onClose();
		} catch (error) {
			if (this.options.target === target) {
				this.errorMessage = error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (this.options.target === target) this.submitting = false;
		}
	}
}
