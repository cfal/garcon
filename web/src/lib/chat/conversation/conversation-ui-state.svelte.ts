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
import type {
	ChatProjectionGenerationTransition,
	ChatTransientFeedMutation,
	ChatTransientFeedSnapshot,
} from '$shared/chat-transient-feed';
import {
	applyProjectionGenerationTransition,
	applyTransientFeedMutation,
	applyTransientFeedSnapshot,
	pendingPermissionsFromTransientFeed,
	type TransientFeedApplyResult,
} from '$lib/chat/transcript/transient-feed-state.js';

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
	readonly transientFeedChatIds: string[];
	setPendingPermissionRequests(update: PendingPermissionRequestUpdate): void;
	clearPendingPermissionRequests(): void;
	clearTurnPermissionRequests(): void;
	setPendingViewChat(chat: PendingViewChat | null): void;
	setPreviousPermissionMode(mode: PermissionMode | null): void;
	getExecutionControl(chatId: string | null | undefined): ChatExecutionControlState | null;
	markExecutionControlSocketDisconnected(): void;
	confirmExecutionControlSocketInstance(serverInstanceId: string): void;
	isExecutionControlSocketInstanceConfirmed(serverInstanceId: string): boolean;
	setExecutionControlFromLiveUpdate(chatId: string, control: ChatExecutionControlState): void;
	setExecutionControlFromRefresh(chatId: string, control: ChatExecutionControlState): void;
	removeExecutionControl(chatId: string): void;
	pruneExecutionControls(activeChatIds: Set<string>): void;
	activateTransientFeed(chatId: string | null): void;
	getTransientFeed(chatId: string): ChatTransientFeedSnapshot | null;
	setTransientFeedFromSnapshot(snapshot: ChatTransientFeedSnapshot): TransientFeedApplyResult;
	applyTransientFeedMutation(mutation: ChatTransientFeedMutation): TransientFeedApplyResult;
	applyProjectionGenerationTransition(
		transition: ChatProjectionGenerationTransition,
	): TransientFeedApplyResult;
	removeTransientFeed(chatId: string): void;
}

export class ConversationUiState implements ConversationUiPort {
	pendingPermissionRequests = $state<PendingPermissionRequest[]>([]);
	pendingViewChat = $state<PendingViewChat | null>(null);
	previousPermissionMode = $state<PermissionMode | null>(null);
	private executionControlByChatId = $state<Record<string, ChatExecutionControlState>>({});
	private transientFeedByChatId = $state.raw<Record<string, ChatTransientFeedSnapshot>>({});
	private activeTransientChatId = $state<string | null>(null);
	private readonly executionControlAuthority = new ExecutionControlInstanceAuthority();

	get executionControlChatIds(): string[] {
		return Object.keys(this.executionControlByChatId);
	}

	get transientFeedChatIds(): string[] {
		return Object.keys(this.transientFeedByChatId);
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
		if (decision.kind === 'replace') {
			this.executionControlByChatId = {};
			this.transientFeedByChatId = {};
			this.#syncActiveTransientPermissions();
		}
	}

	isExecutionControlSocketInstanceConfirmed(serverInstanceId: string): boolean {
		return this.executionControlAuthority.isSocketInstanceConfirmed(serverInstanceId);
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

	activateTransientFeed(chatId: string | null): void {
		this.activeTransientChatId = chatId;
		this.#syncActiveTransientPermissions();
	}

	getTransientFeed(chatId: string): ChatTransientFeedSnapshot | null {
		return this.transientFeedByChatId[chatId] ?? null;
	}

	setTransientFeedFromSnapshot(snapshot: ChatTransientFeedSnapshot): TransientFeedApplyResult {
		if (!this.#acceptTransientInstance(snapshot.serverInstanceId)) return { kind: 'stale' };
		return this.#installTransientResult(
			snapshot.chatId,
			applyTransientFeedSnapshot(this.getTransientFeed(snapshot.chatId), snapshot),
		);
	}

	applyTransientFeedMutation(mutation: ChatTransientFeedMutation): TransientFeedApplyResult {
		if (!this.#acceptTransientInstance(mutation.serverInstanceId)) return { kind: 'stale' };
		return this.#installTransientResult(
			mutation.chatId,
			applyTransientFeedMutation(this.getTransientFeed(mutation.chatId), mutation),
		);
	}

	applyProjectionGenerationTransition(
		transition: ChatProjectionGenerationTransition,
	): TransientFeedApplyResult {
		if (!this.#acceptTransientInstance(transition.serverInstanceId)) return { kind: 'stale' };
		return this.#installTransientResult(
			transition.chatId,
			applyProjectionGenerationTransition(
				this.getTransientFeed(transition.chatId),
				transition,
			),
		);
	}

	removeTransientFeed(chatId: string): void {
		if (!(chatId in this.transientFeedByChatId)) return;
		const next = { ...this.transientFeedByChatId };
		delete next[chatId];
		this.transientFeedByChatId = next;
		this.#syncActiveTransientPermissions();
	}

	#acceptTransientInstance(serverInstanceId: string): boolean {
		const decision = this.executionControlAuthority.classifyNonAuthoritativeInstance(serverInstanceId);
		if (decision.kind === 'reject') return false;
		if (decision.kind === 'replace') {
			this.executionControlByChatId = {};
			this.transientFeedByChatId = {};
		}
		return true;
	}

	#installTransientResult(
		chatId: string,
		result: TransientFeedApplyResult,
	): TransientFeedApplyResult {
		if (result.kind !== 'applied') return result;
		this.transientFeedByChatId = {
			...this.transientFeedByChatId,
			[chatId]: result.snapshot,
		};
		this.#syncActiveTransientPermissions();
		return result;
	}

	#syncActiveTransientPermissions(): void {
		const snapshot = this.activeTransientChatId
			? this.getTransientFeed(this.activeTransientChatId)
			: null;
		this.pendingPermissionRequests = pendingPermissionsFromTransientFeed(snapshot);
	}

	mountExecutionControlPruning(options: ExecutionControlPruningOptions): void {
		$effect(() => {
			this.pruneExecutionControls(options.getActiveChatIds());
		});
	}
}
