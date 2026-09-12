import { tick } from 'svelte';
import { resolveIssueSource } from '$lib/api/issue-source.js';
import { ApiError } from '$lib/api/client.js';
import type { ConversationPanelRegistration } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import type { ChatViewSurfaceId, WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import type { IssueBootstrap, IssueSource } from '$shared/issues';
import * as m from '$lib/paraglide/messages.js';

type Partition = Pick<IssueBootstrap, 'storeId' | 'viewerKey'>;

export interface IssueSourceNavigationDeps {
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
	resolve?: typeof resolveIssueSource;
}

export class IssueSourceNavigationController {
	#pending: { abort: AbortController; valid: () => boolean } | null = null;

	constructor(private readonly deps: IssueSourceNavigationDeps) {}

	invalidate(): void {
		this.#pending?.abort.abort();
		this.#pending = null;
	}

	reconcile(): void {
		if (this.#pending && !this.#pending.valid()) this.invalidate();
	}

	async open(
		source: IssueSource,
		host: WorkspaceWindowId | 'mobile',
		getPartition: () => Partition | null,
	): Promise<void> {
		this.invalidate();
		const partition = getPartition();
		if (!partition || !this.deps.hasChat(source.chatId)) return;
		const authority = this.deps.authority();
		const originFocusRevision = this.deps.workspace.focusOwnerRevision;
		const valid = () =>
			this.deps.authority() === authority &&
			this.deps.hasChat(source.chatId) &&
			getPartition()?.storeId === partition.storeId &&
			getPartition()?.viewerKey === partition.viewerKey;
		const pending = {
			abort: new AbortController(),
			valid: () => valid() && this.deps.workspace.focusOwnerRevision === originFocusRevision,
		};
		this.#pending = pending;
		const current = () =>
			this.#pending === pending && !pending.abort.signal.aborted && pending.valid();
		const timeout = setTimeout(() => {
			if (this.#pending !== pending) return;
			const owned = pending.valid();
			this.invalidate();
			if (owned) this.deps.notifications.error(m.issues_source_failed());
		}, 30_000);
		try {
			const resolution = await (this.deps.resolve ?? resolveIssueSource)(
				source,
				pending.abort.signal,
			);
			if (!current()) return;
			let surfaceId: ChatViewSurfaceId | null = null;
			pending.valid = () => {
				if (!valid()) return false;
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
			if (!current() || this.deps.workspace.lastFocusedSurfaceId !== surfaceId) return;
			if (resolution.kind !== 'found') {
				this.deps.notifications.info(
					resolution.kind === 'transcript-reloaded'
						? m.issues_source_reloaded()
						: m.issues_source_missing(),
				);
				return;
			}
			const targetSurfaceId = surfaceId;
			const panel = this.deps.panels.panel(targetSurfaceId);
			if (!panel || panel.chatId !== source.chatId)
				throw new Error('Conversation panel unavailable');
			const ownsPanel = () => current() && this.deps.panels.panel(targetSurfaceId) === panel;
			const result = await panel.navigateToTranscriptRow(
				resolution.target,
				pending.abort.signal,
				ownsPanel,
			);
			if (!ownsPanel()) return;
			if (result === 'view-changed') this.deps.notifications.info(m.issues_source_reloaded());
			else if (result === 'unavailable') this.deps.notifications.info(m.issues_source_missing());
		} catch (error) {
			if (
				this.#pending !== pending ||
				!pending.valid() ||
				pending.abort.signal.aborted ||
				(error instanceof DOMException && error.name === 'AbortError')
			)
				return;
			this.deps.notifications.error(
				error instanceof ApiError && error.errorCode === 'SESSION_NOT_FOUND'
					? m.issues_source_chat_missing()
					: m.issues_source_failed(),
			);
		} finally {
			clearTimeout(timeout);
			if (this.#pending === pending) this.#pending = null;
		}
	}
}
