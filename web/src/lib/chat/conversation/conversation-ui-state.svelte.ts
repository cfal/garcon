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
	isExecutionControlSocketInstanceConfirmed(serverInstanceId: string): boolean;
	/** Reports whether the incoming control belongs to the authoritative server instance. */
	setExecutionControlFromLiveUpdate(chatId: string, control: ChatExecutionControlState): boolean;
	/** Reports whether the incoming control belongs to the authoritative server instance. */
	setExecutionControlFromRefresh(chatId: string, control: ChatExecutionControlState): boolean;
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

	isExecutionControlSocketInstanceConfirmed(serverInstanceId: string): boolean {
		return this.executionControlAuthority.isSocketInstanceConfirmed(serverInstanceId);
	}

	setExecutionControlFromLiveUpdate(chatId: string, control: ChatExecutionControlState): boolean {
		const decision = this.executionControlAuthority.classifyNonAuthoritativeInstance(
			control.serverInstanceId,
		);
		const instanceAccepted = this.#handleExecutionControlInstanceDecision(decision, chatId, control);
		if (instanceAccepted !== null) return instanceAccepted;
		const current = this.executionControlByChatId[chatId] ?? null;
		if (current && control.version < current.version) return true;
		this.executionControlByChatId = { ...this.executionControlByChatId, [chatId]: control };
		return true;
	}

	setExecutionControlFromRefresh(chatId: string, control: ChatExecutionControlState): boolean {
		const decision = this.executionControlAuthority.classifyNonAuthoritativeInstance(
			control.serverInstanceId,
		);
		const instanceAccepted = this.#handleExecutionControlInstanceDecision(decision, chatId, control);
		if (instanceAccepted !== null) return instanceAccepted;
		const current = this.executionControlByChatId[chatId] ?? null;
		if (current && control.version <= current.version) return true;
		this.executionControlByChatId = { ...this.executionControlByChatId, [chatId]: control };
		return true;
	}

	#handleExecutionControlInstanceDecision(
		decision: ExecutionControlInstanceDecision,
		chatId: string,
		control: ChatExecutionControlState,
	): boolean | null {
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
			return false;
		}
		if (decision.kind === 'replace') {
			this.executionControlByChatId = { [chatId]: control };
			return true;
		}
		return null;
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
