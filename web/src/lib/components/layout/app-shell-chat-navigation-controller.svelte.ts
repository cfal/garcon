import { tick } from 'svelte';
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';

interface AppShellChatNavigationControllerOptions {
	readonly routeChatId: string | undefined;
	readonly selectedChatId: string | null;
	readonly isLoadingChats: boolean;
	readonly currentWindowId: WorkspaceWindowId;
	hasChat(chatId: string): boolean;
	showChatInCurrentWindow(chatId: string): Promise<unknown>;
	setSelectedChatId(chatId: string | null): void;
	navigateToChat(chatId: string): Promise<void>;
	navigateToBareRoute(): Promise<void>;
	requestComposerFocus(): void;
	reportOpenError(error: unknown): void;
	reportDeleteError(error: unknown): void;
}

interface DeletedChatReconciliation {
	chatId: string;
	wasSelected: boolean;
	neighborId: string | null;
	removeLocal(): void;
	clearPresentation(): Promise<void>;
}

interface RouteEcho {
	readonly chatId: string;
}

export class AppShellChatNavigationController {
	pendingChatTarget = $state<string | null>(null);
	pendingWindowId = $state<WorkspaceWindowId | null>(null);

	readonly #options: AppShellChatNavigationControllerOptions;
	#generation = 0;
	readonly #routeEchoes = new Set<RouteEcho>();

	constructor(options: AppShellChatNavigationControllerOptions) {
		this.#options = options;
	}

	handleRouteChat(chatId: string | null): void {
		if (chatId === null) {
			this.#cancelPendingNavigation();
			this.#options.setSelectedChatId(null);
			return;
		}
		if (this.#consumeRouteEcho(chatId)) return;
		void this.showChatInCurrentWindow(chatId, { navigate: false });
	}

	async showChatInCurrentWindow(chatId: string, options: { navigate: boolean }): Promise<void> {
		const generation = this.#begin(chatId);
		try {
			await this.#options.showChatInCurrentWindow(chatId);
			if (!this.#isCurrent(generation)) return;
			if (!this.#options.isLoadingChats && !this.#options.hasChat(chatId)) return;
			this.#options.setSelectedChatId(chatId);
			if (options.navigate && this.#options.routeChatId !== chatId) {
				await this.#navigateToChat(chatId);
			}
			if (this.#isCurrent(generation)) this.#options.requestComposerFocus();
		} catch (error) {
			if (this.#isCurrent(generation)) this.#options.reportOpenError(error);
		} finally {
			this.#complete(generation);
		}
	}

	async synchronizeFocusedChat(chatId: string): Promise<void> {
		const generation = this.#begin(chatId);
		try {
			this.#options.setSelectedChatId(chatId);
			if (this.#options.routeChatId !== chatId) await this.#navigateToChat(chatId);
			if (this.#isCurrent(generation)) this.#options.requestComposerFocus();
		} catch (error) {
			if (this.#isCurrent(generation)) this.#options.reportOpenError(error);
		} finally {
			this.#complete(generation);
		}
	}

	async reconcileDeletedChat(input: DeletedChatReconciliation): Promise<void> {
		const deletionGeneration = this.#beginDeletion(input.chatId, input.wasSelected);
		input.removeLocal();
		try {
			await input.clearPresentation();
		} catch (error) {
			this.#options.reportDeleteError(error);
		}

		if (!input.wasSelected || !this.#canApplyDeletionFallback(deletionGeneration)) return;
		if (input.neighborId && this.#options.hasChat(input.neighborId)) {
			await this.showChatInCurrentWindow(input.neighborId, { navigate: true });
			return;
		}

		this.#options.setSelectedChatId(null);
		try {
			await this.#options.navigateToBareRoute();
		} catch (error) {
			this.#options.reportOpenError(error);
		}
	}

	#begin(chatId: string): number {
		const generation = ++this.#generation;
		this.pendingChatTarget = chatId;
		this.pendingWindowId = this.#options.currentWindowId;
		return generation;
	}

	#beginDeletion(chatId: string, wasSelected: boolean): number {
		const pendingTargetsDeletedChat = this.pendingChatTarget === chatId;
		if (pendingTargetsDeletedChat || (wasSelected && this.pendingChatTarget === null)) {
			this.#generation += 1;
			if (pendingTargetsDeletedChat) this.#clearPendingTarget();
		}
		return this.#generation;
	}

	#canApplyDeletionFallback(generation: number): boolean {
		return (
			this.#isCurrent(generation) &&
			this.pendingChatTarget === null &&
			this.#options.selectedChatId === null
		);
	}

	#isCurrent(generation: number): boolean {
		return generation === this.#generation;
	}

	#complete(generation: number): void {
		if (!this.#isCurrent(generation)) return;
		this.#clearPendingTarget();
	}

	#cancelPendingNavigation(): void {
		this.#generation += 1;
		this.#clearPendingTarget();
	}

	#clearPendingTarget(): void {
		this.pendingChatTarget = null;
		this.pendingWindowId = null;
	}

	async #navigateToChat(chatId: string): Promise<void> {
		const echo: RouteEcho = { chatId };
		this.#routeEchoes.add(echo);
		try {
			await this.#options.navigateToChat(chatId);
		} finally {
			await tick();
			this.#routeEchoes.delete(echo);
		}
	}

	#consumeRouteEcho(chatId: string): boolean {
		for (const echo of this.#routeEchoes) {
			if (echo.chatId !== chatId) continue;
			this.#routeEchoes.delete(echo);
			return true;
		}
		return false;
	}
}
