import { tick } from 'svelte';
import type { ConversationPanelRegistration } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import type {
	TranscriptRowNavigationResult,
	TranscriptRowTarget,
} from '$lib/chat/transcript/transcript-row-navigation.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import type { ChatViewSurfaceId, WorkspaceWindowId } from '$lib/workspace/surface-types.js';

export interface TranscriptNavigationDeps {
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
}

export type TranscriptNavigationResolution =
	| { kind: 'found'; target: TranscriptRowTarget }
	| { kind: 'chat-only' | 'view-changed' | 'unavailable' };

export interface TranscriptNavigationRequest {
	chatId: string;
	host: WorkspaceWindowId | 'mobile';
	ownsSource(): boolean;
	resolve(signal: AbortSignal): Promise<TranscriptNavigationResolution>;
	onResult(result: Exclude<TranscriptRowNavigationResult, 'cancelled'> | 'chat-only'): void;
	onError(error: unknown): void;
}

export class TranscriptNavigationController {
	#pending: { abort: AbortController; ownsNavigation: () => boolean } | null = null;

	constructor(private readonly deps: TranscriptNavigationDeps) {}

	invalidate(): void {
		this.#pending?.abort.abort();
		this.#pending = null;
	}

	reconcile(): void {
		if (this.#pending && !this.#pending.ownsNavigation()) this.invalidate();
	}

	async open(request: TranscriptNavigationRequest): Promise<void> {
		this.invalidate();
		if (!request.ownsSource() || !this.deps.hasChat(request.chatId)) return;
		const authority = this.deps.authority();
		const originFocusRevision = this.deps.workspace.focusOwnerRevision;
		const ownsSource = () =>
			this.deps.authority() === authority &&
			this.deps.hasChat(request.chatId) &&
			request.ownsSource();
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
			if (wasOwned) request.onError(new Error('Transcript navigation timed out'));
		}, 30_000);
		try {
			const resolution = await request.resolve(pending.abort.signal);
			if (!isCurrent()) return;
			if (resolution.kind === 'found' && resolution.target.chatId !== request.chatId)
				throw new Error('Transcript target does not match its chat');
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
				return published?.type === 'chat' && published.chatId === request.chatId;
			};
			surfaceId =
				request.host === 'mobile'
					? await this.deps.workspace.showChatInCurrentWindow(request.chatId)
					: await this.deps.workspace.showChatInWindow(request.chatId, request.host);
			await tick();
			if (!isCurrent()) return;
			if (resolution.kind !== 'found') {
				request.onResult(resolution.kind);
				return;
			}
			const targetSurfaceId = surfaceId;
			const panel = this.deps.panels.panel(targetSurfaceId);
			if (!panel || panel.chatId !== request.chatId)
				throw new Error('Conversation panel unavailable');
			const ownsPanel = () => isCurrent() && this.deps.panels.panel(targetSurfaceId) === panel;
			const result = await panel.navigateToTranscriptRow(
				resolution.target,
				pending.abort.signal,
				ownsPanel,
			);
			if (ownsPanel() && result !== 'cancelled') request.onResult(result);
		} catch (error) {
			if (!isCurrent() || (error instanceof DOMException && error.name === 'AbortError')) return;
			request.onError(error);
		} finally {
			clearTimeout(timeout);
			if (this.#pending === pending) this.#pending = null;
		}
	}
}
