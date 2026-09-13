import { tick } from 'svelte';
import { resolveTicketSource } from '$lib/api/ticket-source.js';
import { ApiError } from '$lib/api/client.js';
import type { ConversationPanelRegistration } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import type { ChatViewSurfaceId, WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import type { TicketBootstrap, TicketSource } from '$shared/tickets';
import * as m from '$lib/paraglide/messages.js';

type Partition = Pick<TicketBootstrap, 'storeId' | 'viewerKey'>;

export interface TicketSourceNavigationDeps {
	workspace: Pick<
		WorkspaceCoordinator,
		| 'showChatInCurrentWindow'
		| 'showChatInWindow'
		| 'lastFocusedSurfaceId'
		| 'focusOwnerRevision'
		| 'focusOwner'
	> & { layout: Pick<WorkspaceCoordinator['layout'], 'surface'> };
	panels: {
		panel(
			surfaceId: ChatViewSurfaceId,
		): Pick<ConversationPanelRegistration, 'chatId' | 'navigateToTranscriptRow'> | null;
	};
	hasChat(chatId: string): boolean;
	authority(): string | null;
	notifications: { info(message: string): void; error(message: string): void };
	resolve?: typeof resolveTicketSource;
}

export class TicketSourceNavigationController {
	#pending: { abort: AbortController; ownsNavigation: () => boolean } | null = null;

	constructor(private readonly deps: TicketSourceNavigationDeps) {}

	invalidate(): void {
		this.#pending?.abort.abort();
		this.#pending = null;
	}

	reconcile(): void {
		if (this.#pending && !this.#pending.ownsNavigation()) this.invalidate();
	}

	async open(
		source: TicketSource,
		host: WorkspaceWindowId | 'mobile',
		getPartition: () => Partition | null,
	): Promise<void> {
		this.invalidate();
		const partition = getPartition();
		if (!partition || !this.deps.hasChat(source.chatId)) return;
		const authority = this.deps.authority();
		const originFocusRevision = this.deps.workspace.focusOwnerRevision;
		const ownsSource = () =>
			this.deps.authority() === authority &&
			this.deps.hasChat(source.chatId) &&
			getPartition()?.storeId === partition.storeId &&
			getPartition()?.viewerKey === partition.viewerKey;
		const pending = {
			abort: new AbortController(),
			ownsNavigation: () =>
				ownsSource() && this.deps.workspace.focusOwnerRevision === originFocusRevision,
		};
		this.#pending = pending;
		const isCurrent = () =>
			this.#pending === pending && !pending.abort.signal.aborted && pending.ownsNavigation();
		const timeout = setTimeout(() => {
			if (this.#pending !== pending) return;
			const wasOwned = pending.ownsNavigation();
			this.invalidate();
			if (wasOwned) this.deps.notifications.error(m.tickets_source_failed());
		}, 30_000);
		try {
			const resolution = await (this.deps.resolve ?? resolveTicketSource)(
				source,
				pending.abort.signal,
			);
			if (!isCurrent()) return;
			let surfaceId: ChatViewSurfaceId | null = null;
			pending.ownsNavigation = () => {
				if (!ownsSource()) return false;
				if (surfaceId !== null && this.deps.workspace.lastFocusedSurfaceId !== surfaceId)
					return false;
				if (this.deps.workspace.focusOwnerRevision === originFocusRevision) return true;
				const owner = this.deps.workspace.focusOwner;
				if (owner.kind !== 'surface') return false;
				if (surfaceId !== null) return owner.surfaceId === surfaceId;
				const published = this.deps.workspace.layout.surface(owner.surfaceId);
				return published?.type === 'chat' && published.chatId === source.chatId;
			};
			surfaceId =
				host === 'mobile'
					? await this.deps.workspace.showChatInCurrentWindow(source.chatId)
					: await this.deps.workspace.showChatInWindow(source.chatId, host);
			await tick();
			if (!isCurrent()) return;
			if (resolution.kind !== 'found') {
				this.deps.notifications.info(
					resolution.kind === 'transcript-reloaded'
						? m.tickets_source_reloaded()
						: m.tickets_source_missing(),
				);
				return;
			}
			const targetSurfaceId = surfaceId;
			const panel = this.deps.panels.panel(targetSurfaceId);
			if (!panel || panel.chatId !== source.chatId)
				throw new Error('Conversation panel unavailable');
			const ownsPanel = () => isCurrent() && this.deps.panels.panel(targetSurfaceId) === panel;
			const result = await panel.navigateToTranscriptRow(
				resolution.target,
				pending.abort.signal,
				ownsPanel,
			);
			if (!ownsPanel()) return;
			if (result === 'view-changed') {
				this.deps.notifications.info(m.tickets_source_reloaded());
			} else if (result === 'unavailable') {
				this.deps.notifications.info(m.tickets_source_missing());
			}
		} catch (error) {
			if (
				this.#pending !== pending ||
				!pending.ownsNavigation() ||
				pending.abort.signal.aborted ||
				(error instanceof DOMException && error.name === 'AbortError')
			)
				return;
			this.deps.notifications.error(
				error instanceof ApiError && error.errorCode === 'SESSION_NOT_FOUND'
					? m.tickets_source_chat_missing()
					: m.tickets_source_failed(),
			);
		} finally {
			clearTimeout(timeout);
			if (this.#pending === pending) this.#pending = null;
		}
	}
}
