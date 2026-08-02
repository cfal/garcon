import type {
	PendingPermissionRequest,
	PendingViewChat,
	PermissionMode,
	ChatExecutionControlState,
} from '$lib/types/chat';
import {
	ExecutionControlInstanceAuthority,
	type ExecutionControlInstanceDecision,
} from './execution-control-instance-authority.js';

export type PendingPermissionRequestUpdate =
	| PendingPermissionRequest[]
	| ((previous: PendingPermissionRequest[]) => PendingPermissionRequest[]);

export interface ExecutionControlPruningOptions {
	getActiveChatIds: () => Set<string>;
}

export interface ConversationUiPort {
	pendingPermissionRequests: PendingPermissionRequest[];
	pendingViewChat: PendingViewChat | null;
	previousPermissionMode: PermissionMode | null;
	readonly executionControlChatIds: string[];
	setPendingPermissionRequests(update: PendingPermissionRequestUpdate): void;
	clearPendingPermissionRequests(): void;
	clearTurnPermissionRequests(): void;
	setPendingViewChat(chat: PendingViewChat | null): void;
	setPreviousPermissionMode(mode: PermissionMode | null): void;
	getExecutionControl(chatId: string | null | undefined): ChatExecutionControlState | null;
	markExecutionControlSocketDisconnected(): void;
	confirmExecutionControlSocketInstance(serverInstanceId: string): void;
	setExecutionControlFromLiveUpdate(chatId: string, control: ChatExecutionControlState): void;
	setExecutionControlFromRefresh(chatId: string, control: ChatExecutionControlState): void;
	removeExecutionControl(chatId: string): void;
	pruneExecutionControls(activeChatIds: Set<string>): void;
}

export class ConversationUiState implements ConversationUiPort {
	pendingPermissionRequests = $state<PendingPermissionRequest[]>([]);
	pendingViewChat = $state<PendingViewChat | null>(null);
	previousPermissionMode = $state<PermissionMode | null>(null);
	private executionControlByChatId = $state<Record<string, ChatExecutionControlState>>({});
	private readonly executionControlAuthority = new ExecutionControlInstanceAuthority();

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

	clearTurnPermissionRequests(): void {
		this.pendingPermissionRequests = this.pendingPermissionRequests.filter(
			(request) => request.permissionRequestId.startsWith('plan-exit-'),
		);
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

	markExecutionControlSocketDisconnected(): void {
		this.executionControlAuthority.markSocketDisconnected();
	}

	confirmExecutionControlSocketInstance(serverInstanceId: string): void {
		const decision = this.executionControlAuthority.confirmSocketInstance(serverInstanceId);
		if (decision.kind === 'replace') this.executionControlByChatId = {};
	}

	setExecutionControlFromLiveUpdate(chatId: string, control: ChatExecutionControlState): void {
		const decision = this.executionControlAuthority.classifyNonAuthoritativeInstance(
			control.serverInstanceId,
		);
		if (this.#handleExecutionControlInstanceDecision(decision, chatId, control)) return;
		const current = this.executionControlByChatId[chatId] ?? null;
		if (current && control.version < current.version) return;
		this.executionControlByChatId = { ...this.executionControlByChatId, [chatId]: control };
	}

	setExecutionControlFromRefresh(chatId: string, control: ChatExecutionControlState): void {
		const decision = this.executionControlAuthority.classifyNonAuthoritativeInstance(
			control.serverInstanceId,
		);
		if (this.#handleExecutionControlInstanceDecision(decision, chatId, control)) return;
		const current = this.executionControlByChatId[chatId] ?? null;
		if (current && control.version <= current.version) return;
		this.executionControlByChatId = { ...this.executionControlByChatId, [chatId]: control };
	}

	#handleExecutionControlInstanceDecision(
		decision: ExecutionControlInstanceDecision,
		chatId: string,
		control: ChatExecutionControlState,
	): boolean {
		if (decision.kind === 'reject') {
			const cached = this.executionControlByChatId[chatId] ?? null;
			console.warn('[ConversationUiState] Rejected execution control instance', {
				reason: decision.reason,
				chatId,
				incomingInstanceId: control.serverInstanceId,
				currentInstanceId: decision.currentInstanceId,
				confirmedSocketInstanceId: decision.confirmedSocketInstanceId,
				incomingVersion: control.version,
				cachedVersion: cached?.version ?? null,
			});
			return true;
		}
		if (decision.kind === 'replace') {
			this.executionControlByChatId = { [chatId]: control };
			return true;
		}
		return false;
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
