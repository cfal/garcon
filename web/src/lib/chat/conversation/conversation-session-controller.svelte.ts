// Owns chat lifecycle, submission, permission, queue, and mode transitions.
// Delegates all viewport operations through the dependency interface.

import { getChatSnapshot, interruptAndSendChat, stopChat } from '$lib/api/chats.js';
import {
	isStopSatisfied,
	type ChatImage,
	type ChatStopOutcome,
} from '$shared/chat-types';
import { createClientCommandId } from '$lib/chat/conversation/client-command-id.js';
import {
	INITIAL_VISIBLE_MESSAGES,
	type ActiveTranscriptPort,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
import type { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import type { JsonValue } from '$shared/json';
import {
	normalizeSupportedPermissionMode,
	normalizeSupportedThinkingMode,
} from '$shared/execution-defaults';
import type { SessionAgentId } from '$lib/types/app';
import type { ApiProtocol } from '$shared/api-providers';
import type {
	PermissionDecisionPayload,
	QueueEntryPlacement,
} from '$shared/chat-command-contracts';
import type { QueueEntry } from '$shared/queue-state';
import {
	ConversationAgentSwitchService,
	type AgentSwitchSelection,
} from '$lib/chat/conversation/conversation-agent-switch-service.js';
import { ConversationSlashCommandService } from '$lib/chat/conversation/conversation-slash-command-service.js';
import { ConversationQueueController } from '$lib/chat/conversation/conversation-queue-controller.svelte.js';
import { ConversationSettingsController } from '$lib/chat/conversation/conversation-settings-controller.svelte.js';
import { HandoffForkConfirmationState } from './handoff-fork-confirmation.svelte.js';
import { ConversationPermissionService } from './conversation-permission-service.js';
import { AcceptedInputSubmissionService } from '$lib/chat/conversation/accepted-input-submission-service.js';
import type { ConversationSubmissionOutcome } from '$lib/chat/conversation/conversation-submission-outcome.js';
import { classifySubmission } from '$lib/chat/conversation/submission-classifier.js';
import {
	errorDetail,
	prepareChatImages,
} from '$lib/chat/conversation/conversation-submission-helpers.js';
import {
	submitDraftRoute,
	submitGoalControlRoute,
	submitQueueRoute,
	submitRunRoute,
	submitSteerPreferenceRoute,
	submitSteerRoute,
} from '$lib/chat/conversation/submission-routes.js';
import * as m from '$lib/paraglide/messages.js';
import {
	ConversationExecutionDraftState,
	executionSelectionFromProjection,
	type ConversationExecutionSelection,
} from './conversation-execution-draft-state.svelte.js';
type SessionTranscriptState = Pick<
	ActiveTranscriptPort,
	| 'activeChatId'
	| 'entries'
	| 'chatMessages'
	| 'getCursor'
	| 'isUserScrolledUp'
	| 'activateChat'
	| 'appendLocalNotice'
	| 'clearOptimisticUserInput'
	| 'markOptimisticUserInputDelivered'
	| 'clearLocalNotices'
	| 'loadMessages'
	| 'upsertOptimisticUserInput'
	| 'excludedResendOrdinals'
	| 'clearResendExclusions'
> & {
	transcriptCache: Pick<ChatTranscriptCache, 'markValidated'>;
};

type SessionComposerState = Pick<
	ComposerState,
	| 'inputText'
	| 'images'
	| 'contentRevision'
	| 'isSubmitting'
	| 'clearAfterSubmit'
	| 'clearImages'
	| 'restoreDraft'
	| 'saveDraft'
>;

type SessionAgentState = Pick<
	AgentState,
	| 'agentId'
	| 'model'
	| 'apiProviderId'
	| 'modelEndpointId'
	| 'modelProtocol'
	| 'permissionMode'
	| 'thinkingMode'
	| 'agentSettings'
	| 'setAgentId'
	| 'setAgentSettings'
	| 'setModelSelection'
>;

type SessionLifecycleState = Pick<
	ConversationLifecycleState,
	| 'currentChatId'
	| 'loadingStatus'
	| 'beginTurn'
	| 'beginStopping'
	| 'clearTurnStatus'
	| 'restoreStopping'
	| 'applyProcessingPhase'
	| 'markTurnRunning'
	| 'setCurrentChatId'
	| 'setLoadingStatus'
>;

type SessionConversationUiState = Pick<
	ConversationUiPort,
	| 'pendingPermissionRequests'
	| 'previousPermissionMode'
	| 'activateTransientFeed'
	| 'getExecutionControl'
	| 'setExecutionControlFromLiveUpdate'
	| 'setExecutionControlFromRefresh'
	| 'isExecutionControlSocketInstanceConfirmed'
	| 'setPendingPermissionRequests'
	| 'setPreviousPermissionMode'
	| 'setTransientFeedFromSnapshot'
>;

type SessionStartupCoordinator = Pick<StartupCoordinator, 'beginLocalStartup' | 'completeStartup'>;
interface DirectAdmissionBarrier {
	settled: Promise<void>;
	release: () => void;
}

function createDirectAdmissionBarrier(): DirectAdmissionBarrier {
	let release!: () => void;
	const settled = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { settled, release };
}

export interface SessionControllerDeps {
	sessions: Pick<
		ChatSessionsPort,
		| 'selectedChatId'
		| 'selectedChat'
		| 'byId'
		| 'startupByChatId'
		| 'isDraft'
		| 'patchDraftStartup'
		| 'patchChat'
		| 'patchLastReadAt'
		| 'applyStartEntry'
		| 'applyProcessingEvent'
		| 'processingPhase'
		| 'upsertServerChat'
		| 'setSelectedChatId'
		| 'renameChat'
		| 'moveChatToBoundary'
		| 'setChatTags'
	>;
	chatState: SessionTranscriptState;
	composerState: SessionComposerState;
	agentState: SessionAgentState;
	lifecycle: SessionLifecycleState;
	conversationUi: SessionConversationUiState;
	startupCoordinator: SessionStartupCoordinator;
	modelCatalog: {
		isLocalModel: (
			agentId: SessionAgentId,
			model: string,
			modelEndpointId?: string | null,
		) => boolean;
		selectionFor: (
			agentId: SessionAgentId,
			model: string,
			modelEndpointId?: string | null,
		) => {
			model: string;
			apiProviderId: string | null;
			modelEndpointId: string | null;
			modelProtocol: ApiProtocol | null;
		};
		selectionValueFor: (
			agentId: SessionAgentId,
			model: string,
			modelEndpointId?: string | null,
		) => string;
		getAgentLabel: (agentId: SessionAgentId) => string;
		getDefaultAgentSettings: (agentId: SessionAgentId) => AgentSettingsEnvelope;
		getPermissionModes: (agentId: SessionAgentId) => readonly PermissionMode[];
		getThinkingModes: (agentId: SessionAgentId) => readonly ThinkingMode[];
		supportsFork: (agentId: SessionAgentId) => boolean;
		supportsForkWhileRunning: (agentId: SessionAgentId) => boolean;
		supportsSteering: (agentId: SessionAgentId) => boolean;
		supportsGoals: (agentId: SessionAgentId) => boolean;
	};
	getExecutionDefaults(agentId: SessionAgentId): Pick<
		ConversationExecutionSelection,
		'permissionMode' | 'thinkingMode' | 'agentSettings'
	>;
	appShell: {
		openNewChatDialog: (opts: { prefill: string }) => void;
	};
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
	navigation: { navigateToChat?: (chatId: string) => void };
	requestProcessingSnapshot: (source: 'admission' | 'stop-probe') => Promise<unknown>;
	setIsViewportPinnedToBottom: (v: boolean) => void;
	setInitialBottomRestorePending: (chatId: string | null) => void;
	scrollToBottom: () => void;
}

export class ConversationSessionController {
	#lastChatId: string | null = null;
	#pendingDirectAdmissions = $state.raw<ReadonlyMap<string, DirectAdmissionBarrier>>(new Map());
	readonly #slashCommands: ConversationSlashCommandService;
	readonly #agentSwitch: ConversationAgentSwitchService;
	readonly #acceptedInputs: AcceptedInputSubmissionService;
	readonly #queue: ConversationQueueController;
	readonly #settings: ConversationSettingsController;
	readonly #permissions: ConversationPermissionService;
	readonly #executionDraft: ConversationExecutionDraftState;
	readonly #handoffForkConfirmation = new HandoffForkConfirmationState();

	constructor(private deps: SessionControllerDeps) {
		this.#executionDraft = new ConversationExecutionDraftState({
			get activeChatId() { return deps.sessions.selectedChatId; },
			get durableSelection() {
				return executionSelectionFromProjection(deps.sessions.selectedChat);
			},
		});
		this.#acceptedInputs = new AcceptedInputSubmissionService();
		this.#slashCommands = new ConversationSlashCommandService({
			...deps,
			refetchTranscript: (chatId) => this.#loadChat(chatId),
			confirmHandoffFork: () => this.#handoffForkConfirmation.ask(),
		}, this.#acceptedInputs);
		this.#agentSwitch = new ConversationAgentSwitchService({
			sessions: deps.sessions,
			agentState: deps.agentState,
			modelCatalog: deps.modelCatalog,
			executionDraft: this.#executionDraft,
			getExecutionDefaults: deps.getExecutionDefaults,
		});
		const acceptedInputs = this.#acceptedInputs;
		const agentSwitch = this.#agentSwitch;
		const executionDraft = this.#executionDraft;
		this.#queue = new ConversationQueueController({
			get sessions() { return deps.sessions; },
			get chatState() { return deps.chatState; },
			get composerState() { return deps.composerState; },
			get lifecycle() { return deps.lifecycle; },
			get conversationUi() { return deps.conversationUi; },
			get acceptedInputs() { return acceptedInputs; },
		});
		const queue = this.#queue;
		this.#permissions = new ConversationPermissionService({
			deps,
			acceptedInputs,
			get queue() { return queue; },
			executionModelSelection: () => this.#executionModelSelection(),
		});
		this.#settings = new ConversationSettingsController({
			get sessions() { return deps.sessions; },
			get agentState() { return deps.agentState; },
			get modelCatalog() { return deps.modelCatalog; },
			get chatState() { return deps.chatState; },
			get agentSwitch() { return agentSwitch; },
			get executionDraft() { return executionDraft; },
		});
	}

	#executionModelSelection(): {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	} {
		const { agentState, modelCatalog } = this.deps;
		const resolved = modelCatalog.selectionFor(
			agentState.agentId,
			agentState.model,
			agentState.modelEndpointId,
		);
		if (resolved.modelEndpointId || !agentState.modelEndpointId) return resolved;
		return {
			model: resolved.model,
			apiProviderId: agentState.apiProviderId,
			modelEndpointId: agentState.modelEndpointId,
			modelProtocol: agentState.modelProtocol,
		};
	}

	#applyExecutionSelection(selection: ConversationExecutionSelection): void {
		const { agentState, modelCatalog } = this.deps;
		agentState.setAgentId(selection.agentId);
		agentState.setModelSelection({
			model: modelCatalog.selectionValueFor(
				selection.agentId,
				selection.model,
				selection.modelEndpointId,
			),
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
		agentState.permissionMode = normalizeSupportedPermissionMode(
			selection.permissionMode,
			modelCatalog.getPermissionModes(selection.agentId),
		);
		agentState.thinkingMode = normalizeSupportedThinkingMode(
			selection.thinkingMode,
			modelCatalog.getThinkingModes(selection.agentId),
		);
		agentState.setAgentSettings(selection.agentSettings);
	}

	#resetSelectionState(): void {
		const { deps } = this;
		const currentChatId = deps.lifecycle.currentChatId;
		deps.chatState.activateChat(null);
		deps.composerState.inputText = '';
		deps.composerState.clearImages();
		if (currentChatId) deps.lifecycle.clearTurnStatus(currentChatId);
		deps.lifecycle.setCurrentChatId(null);
		deps.conversationUi.activateTransientFeed(null);
		deps.setIsViewportPinnedToBottom(true);
		deps.setInitialBottomRestorePending(null);
	}

	// Deduplicates chat-switch calls so the component effect can be stateless.
	handleChatSwitchIfChanged(chatId: string | null): void {
		if (chatId === this.#lastChatId) return;
		// Route selection can arrive before the chat-list record. Defers the
		// transition so hydration can retry without poisoning the dedupe key.
		if (chatId && !this.deps.sessions.byId[chatId]) return;
		if (this.#lastChatId) {
			this.deps.composerState.saveDraft(this.#lastChatId);
		}
		this.#lastChatId = chatId;
		this.handleChatSwitch(chatId);
	}

	// Resets per-chat state and loads messages when the selected chat changes.
	handleChatSwitch(chatId: string | null): void {
		const { deps } = this;
		if (!chatId) {
			this.#resetSelectionState();
			return;
		}

		const selected = deps.sessions.byId[chatId];
		if (!selected?.projectPath) {
			this.#resetSelectionState();
			return;
		}

		deps.setInitialBottomRestorePending(selected.status === 'draft' ? null : chatId);

		// Restores cached messages immediately while the server round-trip completes.
		const restored = deps.chatState.activateChat(chatId);
		if (restored) {
			requestAnimationFrame(() => deps.scrollToBottom());
		}

		deps.composerState.inputText = '';
		deps.composerState.clearImages();
		const previousChatId = deps.lifecycle.currentChatId;
		if (previousChatId) deps.lifecycle.clearTurnStatus(previousChatId);
		deps.conversationUi.activateTransientFeed(chatId);
		deps.setIsViewportPinnedToBottom(true);

		const activeSelection = this.#executionDraft.activate(chatId);
		if (activeSelection) this.#applyExecutionSelection(activeSelection);

		if (selected.status === 'draft') {
			deps.lifecycle.setCurrentChatId(null);
			const startup = deps.sessions.startupByChatId[chatId];
			if (startup) {
				deps.agentState.setAgentId(
					startup.agentId as Parameters<typeof deps.agentState.setAgentId>[0],
				);
				const modelValue = deps.modelCatalog.selectionValueFor(
					startup.agentId,
					startup.model,
					startup.modelEndpointId,
				);
				deps.agentState.setModelSelection({
					model: modelValue,
					apiProviderId: startup.apiProviderId ?? null,
					modelEndpointId: startup.modelEndpointId ?? null,
					modelProtocol: startup.modelProtocol ?? null,
				});
				const startupAgentId = startup.agentId as SessionAgentId;
				deps.agentState.permissionMode = normalizeSupportedPermissionMode(
					startup.permissionMode,
					deps.modelCatalog.getPermissionModes(startupAgentId),
				);
				deps.agentState.thinkingMode = normalizeSupportedThinkingMode(
					startup.thinkingMode,
					deps.modelCatalog.getThinkingModes(startupAgentId),
				);
				deps.agentState.setAgentSettings(startup.agentSettings);
				if (startup.firstMessage?.trim() || (startup.initialImages?.length ?? 0) > 0) {
					const startupText = startup.firstMessage.trim();
					const startupImages = startup.initialImages ?? [];
					const startupChatId = chatId;
					queueMicrotask(() => {
						if (!deps.sessions.byId[startupChatId]) return;
						void this.submitForChat(startupChatId, startupText, startupImages);
					});
				}
			}
			return;
		}

		deps.lifecycle.setCurrentChatId(chatId);
		deps.lifecycle.applyProcessingPhase(chatId, deps.sessions.processingPhase(chatId));
		deps.composerState.restoreDraft(chatId);
		void this.#queue.startControlRefresh(chatId);

		if (
			selected.lastActivityAt &&
			(!selected.lastReadAt || selected.lastReadAt < selected.lastActivityAt)
		) {
			deps.readReceiptOutbox.enqueue(chatId, selected.lastActivityAt);
			deps.sessions.patchLastReadAt(chatId, selected.lastActivityAt);
		}

		this.loadChat(chatId, { minimumMessageLimit: restored?.count ?? 0 });
	}

	async loadChat(chatId: string, options: { minimumMessageLimit?: number } = {}): Promise<void> {
		try {
			await this.#loadChat(chatId, options);
		} catch {
			// Leaves restored messages visible until reconnect or manual retry reloads them.
		}
	}

	async #loadChat(
		chatId: string,
		options: { minimumMessageLimit?: number } = {},
	): Promise<void> {
		const { deps } = this;
		let minimumMessageLimit =
			options.minimumMessageLimit ??
			Math.min(deps.chatState.chatMessages.length, INITIAL_VISIBLE_MESSAGES);

		// Restore from cache if no messages are loaded yet (e.g., WS reconnect path).
		// The primary restore happens earlier in handleChatSwitch.
		if (deps.chatState.chatMessages.length === 0) {
			const restored = deps.chatState.activateChat(chatId);
			minimumMessageLimit = Math.max(minimumMessageLimit, restored?.count ?? 0);
		}

		if (deps.chatState.chatMessages.length > 0) {
			this.#requestBottomRestore(chatId);
		}

		const initialSnapshot = getChatSnapshot(chatId, 1).catch(() => null);
		await deps.chatState.loadMessages(chatId, {
			minimumLimit: minimumMessageLimit,
		});
		if (deps.sessions.selectedChatId !== chatId) return;

		deps.chatState.transcriptCache.markValidated(chatId);
		this.#requestBottomRestore(chatId);

		const record = deps.sessions.byId[chatId];
		if (
			record?.lastActivityAt &&
			(!record.lastReadAt || record.lastReadAt < record.lastActivityAt)
		) {
			deps.readReceiptOutbox.enqueue(chatId, record.lastActivityAt);
			deps.sessions.patchLastReadAt(chatId, record.lastActivityAt);
		}

		const snapshot = await initialSnapshot;
		if (
			deps.sessions.selectedChatId === chatId &&
			snapshot?.chat.id === chatId &&
			snapshot.transcript.availability === 'available' &&
			snapshot.transcript.transcriptViewId === deps.chatState.getCursor().transcriptViewId
		) {
			deps.conversationUi.setTransientFeedFromSnapshot(snapshot.transientFeed);
		}
	}

	#requestBottomRestore(chatId: string): void {
		requestAnimationFrame(() => {
			if (this.deps.sessions.selectedChatId !== chatId || this.deps.chatState.isUserScrolledUp) {
				return;
			}
			this.deps.scrollToBottom();
		});
	}

	isDirectAdmissionPending(chatId: string | null): boolean {
		return chatId !== null && this.#pendingDirectAdmissions.has(chatId);
	}

	#claimDirectAdmission(chatId: string): DirectAdmissionBarrier | null {
		if (this.#pendingDirectAdmissions.has(chatId)) return null;
		const barrier = createDirectAdmissionBarrier();
		const next = new Map(this.#pendingDirectAdmissions);
		next.set(chatId, barrier);
		this.#pendingDirectAdmissions = next;
		return barrier;
	}

	#releaseDirectAdmission(chatId: string, barrier: DirectAdmissionBarrier): void {
		if (this.#pendingDirectAdmissions.get(chatId) !== barrier) return;
		const next = new Map(this.#pendingDirectAdmissions);
		next.delete(chatId);
		this.#pendingDirectAdmissions = next;
		barrier.release();
	}

	#restorePreflightSubmission(
		chatId: string,
		text: string,
		images: File[],
		composerRevisionAfterClear: number | null,
	): void {
		const { composerState, sessions } = this.deps;
		if (
			composerRevisionAfterClear === null ||
			sessions.selectedChatId !== chatId ||
			composerState.contentRevision !== composerRevisionAfterClear
		)
			return;
		composerState.inputText = text;
		composerState.images = images;
		composerState.saveDraft(chatId);
	}

	// Accepts an explicit chat ID so draft startup cannot race selection changes.
	async submitForChat(
		chatId: string,
		messageOverride?: string,
		imageOverride?: File[],
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		const ownsComposer = messageOverride === undefined && imageOverride === undefined;
		while (this.isDirectAdmissionPending(chatId)) {
			if (ownsComposer) return 'no-op';
			await this.#pendingDirectAdmissions.get(chatId)?.settled;
		}
		const selected = deps.sessions.byId[chatId];
		if (!selected?.projectPath) return 'no-op';
		if (selected.status === 'draft' && deps.composerState.isSubmitting) return 'no-op';
		const text = messageOverride ?? deps.composerState.inputText.trim();
		const submissionImages = imageOverride ?? deps.composerState.images;
		if (!text && submissionImages.length === 0) return 'no-op';

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		const handoffPending = selected.status !== 'draft' && this.#executionDraft.isHandoffPending;
		const slash = this.#slashCommands.dispatchSubmission({
			chatId,
			chat: selected,
			text,
			images: [...submissionImages],
			ownsComposer,
			handoffPending,
		});
		if (slash.kind === 'handled') return slash.outcome;
		if (handoffPending && slash.kind === 'goal-control') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_handoff_requires_idle());
			return 'rejected';
		}

		const specializedContext = {
			chatId,
			chat: selected,
			startup: deps.sessions.startupByChatId[chatId],
			text,
			content: slash.content,
			images: [] as ChatImage[],
			previousText,
			previousImages,
			ownsComposer,
			composerRevisionAfterClear: null,
		};
		if (slash.kind === 'steer') {
			return submitSteerRoute(deps, this.#acceptedInputs, specializedContext);
		}
		if (slash.kind === 'goal-control') {
			return submitGoalControlRoute(deps, this.#acceptedInputs, this.#queue, specializedContext);
		}

		const isDraft = selected.status === 'draft';
		const activeTurn = selected.status === 'running' && selected.isProcessing;
		let directAdmission: DirectAdmissionBarrier | null = null;
		if (!isDraft && !activeTurn) {
			directAdmission = this.#claimDirectAdmission(chatId);
			if (!directAdmission) return 'no-op';
		}

		let composerRevisionAfterClear: number | null = null;
		if (ownsComposer) {
			deps.composerState.clearAfterSubmit(chatId);
			composerRevisionAfterClear = deps.composerState.contentRevision;
		}

		try {
			const pendingControlRefresh = this.#queue.pendingControlRefresh(chatId);
			if (!isDraft && !activeTurn && pendingControlRefresh) {
				await this.#queue.settleControlRefresh(pendingControlRefresh);
			}
			const route = classifySubmission({
				isDraft,
				isProcessing: activeTurn,
				handoffPending,
				control: deps.conversationUi.getExecutionControl(chatId),
				hasAttachments: submissionImages.length > 0,
			});
			if (route === 'queue-attachments-unsupported') {
				this.#restorePreflightSubmission(
					chatId,
					previousText,
					previousImages,
					composerRevisionAfterClear,
				);
				deps.chatState.appendLocalNotice('error', m.chat_notice_queue_attachments_unavailable());
				return 'rejected';
			}
			if (route === 'handoff-requires-idle') {
				this.#restorePreflightSubmission(
					chatId,
					previousText,
					previousImages,
					composerRevisionAfterClear,
				);
				deps.chatState.appendLocalNotice('error', m.chat_notice_handoff_requires_idle());
				return 'rejected';
			}
			if (route !== 'direct' && directAdmission) {
				this.#releaseDirectAdmission(chatId, directAdmission);
				directAdmission = null;
			}

			if (route === 'draft') deps.composerState.isSubmitting = true;
			let imagePayload: ChatImage[] = [];
			try {
				if (submissionImages.length > 0) imagePayload = await prepareChatImages(submissionImages);
			} catch (error) {
				console.error('[SessionController] Failed to prepare attachment payload:', error);
				if (route === 'draft') deps.composerState.isSubmitting = false;
				this.#restorePreflightSubmission(
					chatId,
					previousText,
					previousImages,
					composerRevisionAfterClear,
				);
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_prepare_attachments({
						detail: errorDetail(error),
					}),
				);
				return 'rejected';
			}

			const context = {
				chatId,
				chat: selected,
				startup: deps.sessions.startupByChatId[chatId],
				text,
				content: slash.content,
				images: imagePayload,
				previousText,
				previousImages,
				ownsComposer,
				composerRevisionAfterClear,
			};
			if (route === 'queue') {
				return submitQueueRoute(deps, this.#acceptedInputs, this.#queue, context);
			}
			if (route === 'draft') return submitDraftRoute(deps, this.#acceptedInputs, context);
			const currentChat = deps.sessions.byId[chatId];
			const handoff = this.#executionDraft.handoffRequest(
				currentChat?.agentOwnershipEpoch ?? '',
			);
			const outcome = await submitRunRoute(
				deps,
				this.#acceptedInputs,
				this.#queue,
				context,
				this.#executionModelSelection(),
				handoff,
				(chat) => {
					const acceptedSelection = executionSelectionFromProjection(chat);
					if (!acceptedSelection) {
						throw new Error('Accepted handoff projection has incomplete execution settings');
					}
					this.#executionDraft.acceptDurable(acceptedSelection);
					if (deps.sessions.selectedChatId === chatId) {
						this.#applyExecutionSelection(acceptedSelection);
					}
				},
			);
			await deps.requestProcessingSnapshot('admission').catch(() => undefined);
			return outcome;
		} finally {
			if (directAdmission) this.#releaseDirectAdmission(chatId, directAdmission);
		}
	}

	async submitComposerWithSteerPreference(chatId: string): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (deps.sessions.selectedChatId !== chatId || this.isDirectAdmissionPending(chatId)) {
			return 'no-op';
		}
		const selected = deps.sessions.byId[chatId];
		if (!selected?.projectPath) return 'no-op';
		const text = deps.composerState.inputText.trim();
		if (!text) return 'no-op';
		if (selected.status !== 'running' || !selected.isProcessing) {
			return this.submitForChat(chatId);
		}
		return submitSteerPreferenceRoute(deps, this.#acceptedInputs, {
			chatId,
			chat: selected,
			text,
			supportsSteering: deps.modelCatalog.supportsSteering(selected.agentId as SessionAgentId),
			handoffPending: this.#executionDraft.isHandoffPending,
		});
	}

	// Forks a chat without sending a new message, then selects the fork. Backs
	// both the in-chat Fork button and the bare `/fork` command. For agents that
	// support it the server snapshots the transcript up to the last completed
	// turn, so this works while the source chat is still processing.
	get handoffForkConfirmation(): HandoffForkConfirmationState {
		return this.#handoffForkConfirmation;
	}

	forkChat(sourceChatId: string, upToOrdinal?: number): Promise<void> {
		return this.#slashCommands.forkChat(sourceChatId, upToOrdinal);
	}

	handleAbort(): Promise<void> {
		const { conversationUi } = this.deps;
		return this.#requestTurnStop(stopChat, (chatId, result) => {
			conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
		});
	}

	handleInterruptAndSend(): Promise<void> {
		const { conversationUi } = this.deps;
		return this.#requestTurnStop(interruptAndSendChat, (chatId, result) => {
			conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
		});
	}

	#requestTurnStop<T extends { outcome: ChatStopOutcome }>(
		request: (input: Parameters<typeof stopChat>[0]) => Promise<T>,
		onResult?: (chatId: string, result: T) => void,
	): Promise<void> {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return Promise.resolve();
		if (deps.lifecycle.loadingStatus?.can_interrupt === false) return Promise.resolve();
		const clientRequestId = createClientCommandId();
		const previous = deps.lifecycle.beginStopping(chatId, clientRequestId);
		const restore = () => deps.lifecycle.restoreStopping(chatId, clientRequestId, previous);
		const appendFailure = (detail: string) => {
			if (deps.chatState.activeChatId !== chatId) return;
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_stop_chat({ detail }),
			);
		};
		return request({
			clientRequestId,
			chatId,
			agentId: deps.agentState.agentId,
		})
			.then(async (result) => {
				onResult?.(chatId, result);
				await deps.requestProcessingSnapshot('stop-probe').catch(() => undefined);
				if (isStopSatisfied(result.outcome)) return;
				restore();
				appendFailure(m.chat_notice_stop_request_failed());
			})
			.catch((error) => {
				restore();
				appendFailure(errorDetail(error));
			});
	}

	handlePermissionDecision(
		permissionOccurrenceId: string,
		decision: PermissionDecisionPayload,
	): void {
		this.#permissions.handlePermissionDecision(permissionOccurrenceId, decision);
	}

	handleExitPlanMode(
		permissionOccurrenceId: string,
		choice: string,
		plan: string,
	): void {
		this.#permissions.handleExitPlanMode(permissionOccurrenceId, choice, plan);
	}

	handleQueuePause(): Promise<void> {
		return this.#queue.handlePause();
	}

	handleQueueResume(pauseId: string): Promise<void> {
		return this.#queue.handleResume(pauseId);
	}

	handleQueueControlError(action: 'pause' | 'resume', error: unknown): void {
		this.#queue.handleControlError(action, error);
	}

	async pauseQueueForChat(chatId: string): Promise<void> {
		await this.#queue.pauseForChat(chatId);
	}

	async resumeQueueForChat(chatId: string, pauseId: string): Promise<void> {
		await this.#queue.resumeForChat(chatId, pauseId);
	}

	async createQueueEntryForChat(chatId: string, content: string): Promise<void> {
		await this.#queue.createForChat(chatId, content);
	}

	async replaceQueueEntryForChat(
		chatId: string,
		entryId: string,
		content: string,
		expectedRevision: number,
	): Promise<void> {
		await this.#queue.replaceForChat(chatId, entryId, content, expectedRevision);
	}

	async deleteQueueEntryForChat(chatId: string, entryId: string): Promise<void> {
		await this.#queue.deleteForChat(chatId, entryId);
	}

	async moveQueueEntryForChat(
		chatId: string,
		source: QueueEntry,
		target: QueueEntry,
		placement: QueueEntryPlacement,
		reorderRevision: number,
	): Promise<void> {
		await this.#queue.moveForChat(chatId, source, target, placement, reorderRevision);
	}

	async handleSteerQueuedInput(entry: QueueEntry, reorderRevision: number): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId) return;
		await this.#queue.steerHeadForChat(chatId, entry, reorderRevision);
	}

	async handleDeleteQueuedInput(entryId: string): Promise<void> {
		await this.#queue.handleDelete(entryId);
	}

	handleModelSelectionChange(next: AgentSwitchSelection): void {
		this.#settings.handleModelSelectionChange(next);
	}

	handleModelChange(model: string): void {
		this.#settings.handleModelChange(model);
	}

	handlePermissionModeChange(mode: PermissionMode): void {
		this.#settings.handlePermissionModeChange(mode);
	}

	handleThinkingModeChange(mode: ThinkingMode): void {
		this.#settings.handleThinkingModeChange(mode);
	}

	handleAgentSettingChange(descriptor: AgentSettingDescriptor, value: JsonValue): void {
		this.#settings.handleAgentSettingChange(descriptor, value);
	}
}
