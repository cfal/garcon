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
	ChatTransientFeedMutation,
	ChatTransientFeedSnapshot,
} from '$shared/chat-transient-feed';
import {
	applyTransientFeedMutation,
	applyTransientFeedSnapshot,
	pendingPermissionsFromTransientFeed,
	type TransientFeedApplyResult,
} from '$lib/chat/transcript/transient-feed-state.js';
import { untrack } from 'svelte';

export type PendingPermissionRequestUpdate =
	| PendingPermissionRequest[]
	| ((previous: PendingPermissionRequest[]) => PendingPermissionRequest[]);

export interface ExecutionControlPruningOptions {
	getActiveChatIds: () => Set<string>;
}

export interface ConversationUiPort {
	readonly pendingPermissionRequests: PendingPermissionRequest[];
	pendingViewChat: PendingViewChat | null;
	readonly previousPermissionMode: PermissionMode | null;
	readonly executionControlChatIds: string[];
	readonly transientFeedChatIds: string[];
	readonly pendingPermissionChatIds: string[];
	setPendingPermissionRequests(update: PendingPermissionRequestUpdate): void;
	clearPendingPermissionRequests(): void;
	clearTurnPermissionRequests(): void;
	pendingPermissionsFor(chatId: string): readonly PendingPermissionRequest[];
	updatePendingPermissionsForChat(
		chatId: string,
		update: PendingPermissionRequestUpdate,
	): void;
	clearPendingPermissionsForChat(chatId: string): void;
	clearTurnPermissionRequestsForChat(chatId: string): void;
	setPendingViewChat(chat: PendingViewChat | null): void;
	setPreviousPermissionMode(mode: PermissionMode | null): void;
	beginPlanModeForChat(chatId: string, previousMode: PermissionMode): void;
	previousPermissionModeFor(chatId: string): PermissionMode | null;
	finishPlanModeForChat(chatId: string): PermissionMode | null;
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
	removeTransientFeed(chatId: string): void;
}

export class ConversationUiState implements ConversationUiPort {
	pendingViewChat = $state<PendingViewChat | null>(null);
	private executionControlByChatId = $state<Record<string, ChatExecutionControlState>>({});
	private transientFeedByChatId = $state.raw<Record<string, ChatTransientFeedSnapshot>>({});
	private pendingPermissionRequestsByChatId =
		$state.raw<Record<string, PendingPermissionRequest[]>>({});
	private unassignedPendingPermissionRequests = $state<PendingPermissionRequest[]>([]);
	private previousPermissionModeByChatId = $state.raw<Record<string, PermissionMode>>({});
	private unassignedPreviousPermissionMode = $state<PermissionMode | null>(null);
	private activeTransientChatId = $state<string | null>(null);
	private readonly executionControlAuthority = new ExecutionControlInstanceAuthority();

	get pendingPermissionRequests(): PendingPermissionRequest[] {
		const chatId = this.activeTransientChatId;
		return chatId
			? [...this.pendingPermissionsFor(chatId)]
			: this.unassignedPendingPermissionRequests;
	}

	get previousPermissionMode(): PermissionMode | null {
		const chatId = this.activeTransientChatId;
		return chatId
			? this.previousPermissionModeFor(chatId)
			: this.unassignedPreviousPermissionMode;
	}

	get executionControlChatIds(): string[] {
		return Object.keys(this.executionControlByChatId);
	}

	get transientFeedChatIds(): string[] {
		return Object.keys(this.transientFeedByChatId);
	}

	get pendingPermissionChatIds(): string[] {
		return Object.keys(this.pendingPermissionRequestsByChatId);
	}

	setPendingPermissionRequests(update: PendingPermissionRequestUpdate): void {
		const chatId = this.activeTransientChatId;
		if (chatId) {
			this.updatePendingPermissionsForChat(chatId, update);
			return;
		}
		this.unassignedPendingPermissionRequests =
			typeof update === 'function'
				? update(this.unassignedPendingPermissionRequests)
				: update;
	}

	clearPendingPermissionRequests(): void {
		const chatId = this.activeTransientChatId;
		if (chatId) {
			this.clearPendingPermissionsForChat(chatId);
			return;
		}
		this.unassignedPendingPermissionRequests = [];
	}

	clearTurnPermissionRequests(): void {
		const chatId = this.activeTransientChatId;
		if (chatId) {
			this.clearTurnPermissionRequestsForChat(chatId);
			return;
		}
		this.unassignedPendingPermissionRequests =
			this.unassignedPendingPermissionRequests.filter(
			(request) => request.requestedTool.type === 'exit-plan-mode-tool-use',
		);
	}

	pendingPermissionsFor(chatId: string): readonly PendingPermissionRequest[] {
		return this.pendingPermissionRequestsByChatId[chatId] ?? [];
	}

	updatePendingPermissionsForChat(
		chatId: string,
		update: PendingPermissionRequestUpdate,
	): void {
		const previous = this.pendingPermissionRequestsByChatId[chatId] ?? [];
		const next = typeof update === 'function' ? update(previous) : update;
		if (next === previous) return;
		this.#setPendingPermissionsForChat(chatId, next);
	}

	clearPendingPermissionsForChat(chatId: string): void {
		this.#setPendingPermissionsForChat(chatId, []);
	}

	clearTurnPermissionRequestsForChat(chatId: string): void {
		this.updatePendingPermissionsForChat(chatId, (requests) =>
			requests.filter((request) => request.requestedTool.type === 'exit-plan-mode-tool-use'),
		);
	}

	setPendingViewChat(chat: PendingViewChat | null): void {
		this.pendingViewChat = chat;
	}

	setPreviousPermissionMode(mode: PermissionMode | null): void {
		const chatId = this.activeTransientChatId;
		if (!chatId) {
			this.unassignedPreviousPermissionMode = mode;
			return;
		}
		if (mode === null) {
			this.finishPlanModeForChat(chatId);
			return;
		}
		this.previousPermissionModeByChatId = {
			...this.previousPermissionModeByChatId,
			[chatId]: mode,
		};
	}

	beginPlanModeForChat(chatId: string, previousMode: PermissionMode): void {
		if (chatId in this.previousPermissionModeByChatId) return;
		this.previousPermissionModeByChatId = {
			...this.previousPermissionModeByChatId,
			[chatId]: previousMode,
		};
	}

	previousPermissionModeFor(chatId: string): PermissionMode | null {
		return this.previousPermissionModeByChatId[chatId] ?? null;
	}

	finishPlanModeForChat(chatId: string): PermissionMode | null {
		const previousMode = this.previousPermissionModeByChatId[chatId] ?? null;
		if (previousMode === null) return null;
		const next = { ...this.previousPermissionModeByChatId };
		delete next[chatId];
		this.previousPermissionModeByChatId = next;
		return previousMode;
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
			this.pendingPermissionRequestsByChatId = {};
			this.previousPermissionModeByChatId = {};
			this.unassignedPendingPermissionRequests = [];
			this.unassignedPreviousPermissionMode = null;
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
		if (!chatId) return;
		if (this.unassignedPendingPermissionRequests.length > 0) {
			const pending = this.unassignedPendingPermissionRequests.map((request) =>
				request.chatId ? request : { ...request, chatId },
			);
			this.unassignedPendingPermissionRequests = [];
			this.updatePendingPermissionsForChat(chatId, (current) =>
				this.#mergePermissionRequests(current, pending),
			);
		}
		if (this.unassignedPreviousPermissionMode !== null) {
			this.beginPlanModeForChat(chatId, this.unassignedPreviousPermissionMode);
			this.unassignedPreviousPermissionMode = null;
		}
		this.#syncTransientPermissions(chatId);
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

	removeTransientFeed(chatId: string): void {
		if (chatId in this.transientFeedByChatId) {
			const next = { ...this.transientFeedByChatId };
			delete next[chatId];
			this.transientFeedByChatId = next;
		}
		this.clearPendingPermissionsForChat(chatId);
		this.finishPlanModeForChat(chatId);
	}

	#acceptTransientInstance(serverInstanceId: string): boolean {
		const decision = this.executionControlAuthority.classifyNonAuthoritativeInstance(serverInstanceId);
		if (decision.kind === 'reject') return false;
		if (decision.kind === 'replace') {
			this.executionControlByChatId = {};
			this.transientFeedByChatId = {};
			this.pendingPermissionRequestsByChatId = {};
			this.previousPermissionModeByChatId = {};
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
		this.#syncTransientPermissions(chatId);
		return result;
	}

	#syncTransientPermissions(chatId: string): void {
		const snapshot = this.getTransientFeed(chatId);
		if (!snapshot) return;
		const transientPermissions = pendingPermissionsFromTransientFeed(snapshot);
		const exitPlanPermissions = this.pendingPermissionsFor(chatId).filter(
			(request) => request.requestedTool.type === 'exit-plan-mode-tool-use',
		);
		this.#setPendingPermissionsForChat(
			chatId,
			this.#mergePermissionRequests(exitPlanPermissions, transientPermissions),
		);
	}

	#setPendingPermissionsForChat(
		chatId: string,
		requests: readonly PendingPermissionRequest[],
	): void {
		if (requests.length === 0) {
			if (!(chatId in this.pendingPermissionRequestsByChatId)) return;
			const next = { ...this.pendingPermissionRequestsByChatId };
			delete next[chatId];
			this.pendingPermissionRequestsByChatId = next;
			return;
		}
		this.pendingPermissionRequestsByChatId = {
			...this.pendingPermissionRequestsByChatId,
			[chatId]: [...requests],
		};
	}

	#mergePermissionRequests(
		first: readonly PendingPermissionRequest[],
		second: readonly PendingPermissionRequest[],
	): PendingPermissionRequest[] {
		const byOccurrence = new Map(
			first.map((request) => [request.permissionOccurrenceId, request]),
		);
		for (const request of second) byOccurrence.set(request.permissionOccurrenceId, request);
		return [...byOccurrence.values()];
	}

	mountExecutionControlPruning(options: ExecutionControlPruningOptions): void {
		$effect(() => {
			const activeChatIds = options.getActiveChatIds();
			untrack(() => this.pruneExecutionControls(activeChatIds));
		});
	}
}
