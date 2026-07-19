import type {
	PendingPermissionRequest,
	PendingViewChat,
	PermissionMode,
	ChatExecutionControlState,
} from '$lib/types/chat';

export type PendingPermissionRequestUpdate =
	| PendingPermissionRequest[]
	| ((previous: PendingPermissionRequest[]) => PendingPermissionRequest[]);

export interface ExecutionControlPruningOptions {
	getActiveChatIds: () => Set<string>;
}

function controlVersion(control: ChatExecutionControlState | null): number {
	return control?.version ?? -1;
}

export class ConversationUiState {
	pendingPermissionRequests = $state<PendingPermissionRequest[]>([]);
	pendingViewChat = $state<PendingViewChat | null>(null);
	previousPermissionMode = $state<PermissionMode | null>(null);
	private executionControlByChatId = $state<Record<string, ChatExecutionControlState | null>>({});

	get executionControlChatIds(): string[] {
		return Object.keys(this.executionControlByChatId);
	}

	setPendingPermissionRequests(update: PendingPermissionRequestUpdate): void {
		this.pendingPermissionRequests =
			typeof update === 'function' ? update(this.pendingPermissionRequests) : update;
	}

	clearPendingPermissionRequests(): void {
		this.pendingPermissionRequests = [];
	}

	setPendingViewChat(chat: PendingViewChat | null): void {
		this.pendingViewChat = chat;
	}

	setPreviousPermissionMode(mode: PermissionMode | null): void {
		this.previousPermissionMode = mode;
	}

	getExecutionControl(chatId: string | null | undefined): ChatExecutionControlState | null {
		if (!chatId) return null;
		return this.executionControlByChatId[chatId] ?? null;
	}

	setExecutionControl(chatId: string, control: ChatExecutionControlState | null): void {
		const current = this.executionControlByChatId[chatId] ?? null;
		if (controlVersion(control) < controlVersion(current)) return;
		this.executionControlByChatId = { ...this.executionControlByChatId, [chatId]: control };
	}

	setExecutionControlFromRefresh(chatId: string, control: ChatExecutionControlState | null): void {
		const current = this.executionControlByChatId[chatId] ?? null;
		if (current && controlVersion(control) <= controlVersion(current)) return;
		this.executionControlByChatId = { ...this.executionControlByChatId, [chatId]: control };
	}

	removeExecutionControl(chatId: string): void {
		if (!(chatId in this.executionControlByChatId)) return;
		const nextControlByChatId = { ...this.executionControlByChatId };
		delete nextControlByChatId[chatId];
		this.executionControlByChatId = nextControlByChatId;
	}

	pruneExecutionControls(activeChatIds: Set<string>): void {
		const staleIds = Object.keys(this.executionControlByChatId).filter(
			(chatId) => !activeChatIds.has(chatId),
		);
		if (staleIds.length === 0) return;

		const nextControlByChatId = { ...this.executionControlByChatId };
		for (const chatId of staleIds) {
			delete nextControlByChatId[chatId];
		}
		this.executionControlByChatId = nextControlByChatId;
	}

	mountExecutionControlPruning(options: ExecutionControlPruningOptions): void {
		$effect(() => {
			this.pruneExecutionControls(options.getActiveChatIds());
		});
	}
}
