// Starts a new chat that works on one ticket, then assigns the ticket to that
// chat. Every dispatch surface (create dialog, ticket detail) shares this
// controller, so they share one selection, one prompt, and one start path.

import { validateStart } from '$lib/api/chats.js';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { NewChatConfig, SessionAgentId } from '$lib/types/app.js';
import type { ChatStatus } from '$lib/types/chat-session.js';
import * as m from '$lib/paraglide/messages.js';
import type { ChatId } from '$shared/chat-id';
import type { ApiProtocol } from '$shared/api-providers';
import { normalizeThinkingMode, type ThinkingMode } from '$shared/chat-modes';
import { createClientChatId } from '$shared/client-chat-id';
import { effectiveExecutorId } from '$shared/executors';
import type { RemoteSettingsSnapshot, TicketDispatchUiSettings, UpdateRemoteSettingsInput } from '$shared/settings';
import { renderTicketDispatchPrompt, type TicketDispatchSubject } from '$shared/ticket-dispatch';
import {
	hasSavedTicketDispatchSelection,
	resolveTicketDispatchSelection,
	type TicketDispatchSelectionResult,
} from './ticket-dispatch-selection.js';

/** Bounds how long a dispatch waits for the server to accept the chat before it skips assignment. */
export const TICKET_DISPATCH_START_TIMEOUT_MS = 120_000;

/** Structurally matches the model selector value, which domain code cannot import. */
export interface TicketDispatchSelectorValue {
	executorId?: string | null;
	agentId: SessionAgentId;
	model: string;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	thinkingMode?: ThinkingMode;
}

export interface TicketDispatchSelectionChange {
	executorId?: string;
	agentId: SessionAgentId;
	modelValue: string;
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
	thinkingMode?: ThinkingMode;
}

export interface TicketDispatchMutations {
	assignToChat(ticketId: string, chatId: string): Promise<boolean>;
}

export type TicketDispatchPromptSaveResult = { ok: true } | { ok: false; message: string };

export interface TicketDispatchControllerDeps {
	readonly remoteSettings: {
		readonly snapshot: RemoteSettingsSnapshot | null;
		ensureLoaded(): Promise<RemoteSettingsSnapshot>;
		update(patch: UpdateRemoteSettingsInput): Promise<RemoteSettingsSnapshot>;
	};
	readonly modelCatalog: Pick<ModelCatalogStore, 'forExecutor'>;
	readonly executors?: { isReady(id?: string | null): boolean };
	readonly sessions: { readonly byId: Readonly<Record<string, { readonly status: ChatStatus }>> };
	readonly notifications: { error(message: string): unknown };
	readonly startChat: (chatId: ChatId, config: NewChatConfig) => void;
	readonly validateProject?: (
		path: string,
		executorId: string,
	) => Promise<{ valid: boolean; error?: string }>;
	readonly createChatId?: () => ChatId;
	readonly startTimeoutMs?: number;
}

const SELECTION_KEYS = [
	'executorId',
	'agentId',
	'model',
	'apiProviderId',
	'modelEndpointId',
	'modelProtocol',
	'thinkingMode',
] as const;

export class TicketDispatchController {
	selectionOverride = $state<TicketDispatchSelectorValue | null>(null);
	#pendingSaves = $state(0);
	saveError = $state<string | null>(null);
	#dispatching = $state<ReadonlySet<string>>(new Set());
	#selectionSaveToken = 0;

	constructor(private readonly deps: TicketDispatchControllerDeps) {}

	get saving(): boolean {
		return this.#pendingSaves > 0;
	}

	get saved(): TicketDispatchUiSettings | undefined {
		return this.deps.remoteSettings.snapshot?.ui.ticketDispatch;
	}

	get followsNewChatDefaults(): boolean {
		return !this.selectionOverride && !hasSavedTicketDispatchSelection(this.saved);
	}

	get customPrompt(): string {
		return this.saved?.customPrompt ?? '';
	}

	get resolution(): TicketDispatchSelectionResult {
		const snapshot = this.deps.remoteSettings.snapshot;
		return resolveTicketDispatchSelection({
			saved: this.saved,
			recents: snapshot?.recentAgentSettings ?? [],
			executionDefaults: snapshot?.executionDefaults ?? null,
			catalogFor: (executorId) => this.deps.modelCatalog.forExecutor(executorId),
		});
	}

	/** Value shown by the dispatch model selector, including an unavailable saved choice. */
	get selectorValue(): TicketDispatchSelectorValue {
		if (this.selectionOverride) return this.selectionOverride;
		const resolution = this.resolution;
		if (resolution.kind === 'ready') {
			const { selection } = resolution;
			return {
				executorId: selection.executorId,
				agentId: selection.agentId,
				model: selection.modelValue,
				apiProviderId: selection.model.apiProviderId,
				modelEndpointId: selection.model.modelEndpointId,
				modelProtocol: selection.model.modelProtocol,
				thinkingMode: selection.thinkingMode,
			};
		}
		const saved = this.saved;
		return {
			executorId: resolution.executorId,
			agentId: saved?.agentId ?? '',
			model: saved?.model ?? '',
			apiProviderId: saved?.apiProviderId ?? null,
			modelEndpointId: saved?.modelEndpointId ?? null,
			modelProtocol: saved?.modelProtocol ?? null,
			thinkingMode: normalizeThinkingMode(saved?.thinkingMode),
		};
	}

	isDispatching(ticketId: string): boolean {
		return this.#dispatching.has(ticketId);
	}

	async persistSelection(next: TicketDispatchSelectionChange): Promise<void> {
		const token = ++this.#selectionSaveToken;
		const executorId = effectiveExecutorId(next.executorId);
		const thinkingMode = normalizeThinkingMode(next.thinkingMode);
		this.selectionOverride = {
			executorId,
			agentId: next.agentId,
			model: next.modelValue,
			apiProviderId: next.apiProviderId,
			modelEndpointId: next.modelEndpointId,
			modelProtocol: next.modelProtocol,
			thinkingMode,
		};
		await this.#save({
			...this.saved,
			executorId,
			agentId: next.agentId,
			model: next.model,
			apiProviderId: next.apiProviderId,
			modelEndpointId: next.modelEndpointId,
			modelProtocol: next.modelProtocol,
			thinkingMode,
		});
		// Only the latest selection may clear the optimistic value, whether it saved or failed.
		if (token === this.#selectionSaveToken) this.selectionOverride = null;
	}

	async followNewChat(): Promise<void> {
		if (this.followsNewChatDefaults) return;
		const token = ++this.#selectionSaveToken;
		const next: TicketDispatchUiSettings = { ...this.saved };
		for (const key of SELECTION_KEYS) delete next[key];
		await this.#save(next);
		if (token === this.#selectionSaveToken) this.selectionOverride = null;
	}

	async persistPrompt(customPrompt: string): Promise<TicketDispatchPromptSaveResult> {
		const saved = await this.#save({ ...this.saved, customPrompt });
		return saved ? { ok: true } : { ok: false, message: this.saveError ?? m.settings_save_failed() };
	}

	/**
	 * Starts a chat for the ticket with the saved selection and prompt, then
	 * assigns the ticket to the chat once the server accepts the start. The
	 * ticket service rejects an assignee chat that does not exist yet.
	 */
	async dispatch(ticket: TicketDispatchSubject, tickets: TicketDispatchMutations): Promise<boolean> {
		if (this.isDispatching(ticket.id)) return false;
		this.#setDispatching(ticket.id, true);
		let chatId: ChatId;
		try {
			const config = await this.#prepare(ticket);
			if (!config) return false;
			chatId = (this.deps.createChatId ?? createClientChatId)();
			this.deps.startChat(chatId, config);
		} finally {
			this.#setDispatching(ticket.id, false);
		}
		if (await this.#waitForStartedChat(chatId)) await tickets.assignToChat(ticket.id, chatId);
		return true;
	}

	async #prepare(ticket: TicketDispatchSubject): Promise<NewChatConfig | null> {
		try {
			await this.deps.remoteSettings.ensureLoaded();
		} catch {
			return this.#fail(m.tickets_dispatch_settings_unavailable());
		}
		const executorId = effectiveExecutorId(this.saved?.executorId);
		if (this.deps.executors && !this.deps.executors.isReady(executorId))
			return this.#fail(m.tickets_dispatch_executor_unavailable());
		const catalog = this.deps.modelCatalog.forExecutor(executorId);
		// Matches the new-chat gate: never start from a cached catalog the executor has not confirmed.
		if (!catalog.isValidated) await catalog.refreshIfStale().catch(() => undefined);
		if (!catalog.isValidated)
			return this.#fail(catalog.error ?? m.tickets_dispatch_model_unavailable());
		const resolution = this.resolution;
		if (resolution.kind !== 'ready') return this.#fail(m.tickets_dispatch_model_unavailable());
		const { selection } = resolution;

		const project = await this.#validateProject(ticket.project, executorId);
		if (!project.valid)
			return this.#fail(
				m.tickets_dispatch_project_invalid({
					project: ticket.project,
					detail: project.error ?? m.chat_new_chat_errors_invalid_directory(),
				}),
			);

		return {
			executorId: selection.executorId,
			agentId: selection.agentId,
			projectPath: ticket.project,
			model: selection.model.model,
			apiProviderId: selection.model.apiProviderId,
			modelEndpointId: selection.model.modelEndpointId,
			modelProtocol: selection.model.modelProtocol,
			permissionMode: selection.permissionMode,
			thinkingMode: selection.thinkingMode,
			agentSettings: selection.agentSettings,
			firstMessage: renderTicketDispatchPrompt(this.saved?.customPrompt, ticket),
		};
	}

	async #validateProject(
		path: string,
		executorId: string,
	): Promise<{ valid: boolean; error?: string }> {
		if (this.deps.validateProject) return this.deps.validateProject(path, executorId);
		try {
			const result = await validateStart(path, { executorId });
			return { valid: result.valid, error: result.error };
		} catch (error) {
			return { valid: false, error: error instanceof Error ? error.message : undefined };
		}
	}

	#waitForStartedChat(chatId: string): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			let stop: (() => void) | null = null;
			const finish = (started: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				queueMicrotask(() => stop?.());
				resolve(started);
			};
			const timer = setTimeout(
				() => finish(false),
				this.deps.startTimeoutMs ?? TICKET_DISPATCH_START_TIMEOUT_MS,
			);
			// A deleted draft never starts; a draft that became a server chat did.
			stop = $effect.root(() => {
				$effect(() => {
					const status = this.deps.sessions.byId[chatId]?.status;
					if (status === undefined) finish(false);
					else if (status !== 'draft') finish(true);
				});
			});
		});
	}

	async #save(ticketDispatch: TicketDispatchUiSettings): Promise<boolean> {
		this.saveError = null;
		this.#pendingSaves += 1;
		try {
			await this.deps.remoteSettings.update({ ui: { ticketDispatch } });
			return true;
		} catch (error) {
			this.saveError = error instanceof Error ? error.message : m.settings_save_failed();
			return false;
		} finally {
			this.#pendingSaves -= 1;
		}
	}

	#fail(message: string): null {
		this.deps.notifications.error(message);
		return null;
	}

	#setDispatching(ticketId: string, dispatching: boolean): void {
		const next = new Set(this.#dispatching);
		if (dispatching) next.add(ticketId);
		else next.delete(ticketId);
		this.#dispatching = next;
	}
}
