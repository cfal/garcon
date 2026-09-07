import type { ChatBoardApi } from '$lib/api/chat-boards.js';
import { ApiError } from '$lib/api/client.js';
import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import {
	normalizeChatBoardCatalog,
	type ChatBoard,
	type ChatBoardCatalog,
} from '$shared/chat-boards';
import type { ChatBoardInvalidationHub } from './chat-board-invalidation-hub.js';

export type ChatBoardLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ChatBoardPreferencesPort {
	get selectedBoardId(): string | null;
	setSelectedBoardId(boardId: string | null): void;
	get itemLayout(): ChatItemLayout | null;
	setItemLayout(layout: ChatItemLayout): void;
	getActiveColumnId(boardId: string): string | null;
	setActiveColumnId(boardId: string, columnId: string): void;
}

export interface ChatBoardControllerDeps {
	readonly api: ChatBoardApi;
	readonly invalidations: ChatBoardInvalidationHub;
	readonly preferences: ChatBoardPreferencesPort;
	readonly sidebarLayout: () => ChatItemLayout;
}

export class ChatBoardController implements PortableSingletonController {
	#catalog = $state<ChatBoardCatalog>({ revision: 0, boards: [] });
	#status = $state<ChatBoardLoadStatus>('idle');
	#error = $state<string | null>(null);
	#presentationVisible = false;
	#disposed = false;
	#fetchGeneration = 0;
	#inFlight: Promise<void> | null = null;
	#needsRefresh = false;
	#requiredRevision = 0;
	#unsubscribe: (() => void) | null;

	constructor(private readonly deps: ChatBoardControllerDeps) {
		this.#unsubscribe = deps.invalidations.subscribe((event) => {
			if (event.kind === 'reconnect') {
				if (this.#status !== 'idle') this.#needsRefresh = true;
			} else if (event.revision > this.#catalog.revision) {
				this.#requiredRevision = Math.max(this.#requiredRevision, event.revision);
				this.#needsRefresh = true;
			}
			if (this.#presentationVisible && this.#needsRefresh) void this.refresh(false);
		});
	}

	get catalog(): ChatBoardCatalog {
		return this.#catalog;
	}

	get status(): ChatBoardLoadStatus {
		return this.#status;
	}

	get error(): string | null {
		return this.#error;
	}

	get itemLayout(): ChatItemLayout {
		return this.deps.preferences.itemLayout ?? this.deps.sidebarLayout();
	}

	get selectedBoard(): ChatBoard | null {
		return (
			this.#catalog.boards.find((board) => board.id === this.deps.preferences.selectedBoardId) ??
			this.#catalog.boards[0] ??
			null
		);
	}

	get activeColumnId(): string | null {
		const board = this.selectedBoard;
		if (!board) return null;
		const saved = this.deps.preferences.getActiveColumnId(board.id);
		return board.columns.some((column) => column.id === saved)
			? saved
			: (board.columns[0]?.id ?? null);
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		void projectState;
	}

	setPresentationVisible(visible: boolean): void {
		if (this.#disposed || this.#presentationVisible === visible) return;
		this.#presentationVisible = visible;
		if (!visible) return;
		if (this.deps.preferences.itemLayout === null) {
			this.deps.preferences.setItemLayout(this.deps.sidebarLayout());
		}
		if (this.#status === 'idle' || this.#needsRefresh) void this.refresh(this.#status === 'idle');
	}

	selectBoard(boardId: string): void {
		if (!this.#catalog.boards.some((board) => board.id === boardId)) return;
		this.deps.preferences.setSelectedBoardId(boardId);
	}

	selectColumn(columnId: string): void {
		const board = this.selectedBoard;
		if (!board?.columns.some((column) => column.id === columnId)) return;
		this.deps.preferences.setActiveColumnId(board.id, columnId);
	}

	setItemLayout(layout: ChatItemLayout): void {
		this.deps.preferences.setItemLayout(layout);
	}

	async refresh(initial = this.#status === 'idle'): Promise<void> {
		if (this.#inFlight) {
			this.#needsRefresh = true;
			return this.#inFlight;
		}
		const generation = ++this.#fetchGeneration;
		if (initial) this.#status = 'loading';
		this.#needsRefresh = false;
		let succeeded = false;
		this.#inFlight = (async () => {
			try {
				const catalog = await this.deps.api.load();
				if (this.#disposed || generation !== this.#fetchGeneration) return;
				if (catalog.revision >= this.#catalog.revision) this.#applyCatalog(catalog);
				if (this.#catalog.revision < this.#requiredRevision) this.#needsRefresh = true;
				this.#status = 'ready';
				this.#error = null;
				succeeded = true;
			} catch (error) {
				if (this.#disposed || generation !== this.#fetchGeneration) return;
				this.#error = error instanceof Error ? error.message : String(error);
				if (this.#status !== 'ready') this.#status = 'error';
			} finally {
				if (generation === this.#fetchGeneration) this.#inFlight = null;
			}
		})();
		await this.#inFlight;
		if (succeeded && this.#needsRefresh && this.#presentationVisible) await this.refresh(false);
	}

	async createBoard(name: string): Promise<string> {
		try {
			const result = await this.deps.api.create(this.#catalog.revision, name);
			this.#applyCatalog(result.catalog);
			this.deps.preferences.setSelectedBoardId(result.boardId);
			return result.boardId;
		} catch (error) {
			this.#applyConflictCatalog(error);
			throw error;
		}
	}

	async updateBoard(board: ChatBoard, expectedRevision = this.#catalog.revision): Promise<void> {
		try {
			const result = await this.deps.api.update(expectedRevision, board);
			this.#applyCatalog(result.catalog);
		} catch (error) {
			this.#applyConflictCatalog(error);
			throw error;
		}
	}

	async removeBoard(boardId: string): Promise<void> {
		try {
			const result = await this.deps.api.remove(this.#catalog.revision, boardId);
			this.#applyCatalog(result.catalog);
		} catch (error) {
			this.#applyConflictCatalog(error);
			throw error;
		}
	}

	async reorderBoards(orderedBoardIds: readonly string[]): Promise<void> {
		try {
			const result = await this.deps.api.reorder(this.#catalog.revision, orderedBoardIds);
			this.#applyCatalog(result.catalog);
		} catch (error) {
			this.#applyConflictCatalog(error);
			throw error;
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#presentationVisible = false;
		this.#fetchGeneration += 1;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	#applyCatalog(catalog: ChatBoardCatalog): void {
		if (catalog.revision < this.#catalog.revision) return;
		const previous = this.#catalog;
		this.#catalog = catalog;
		const selected = this.deps.preferences.selectedBoardId;
		if (selected && !catalog.boards.some((board) => board.id === selected)) {
			const previousIndex = previous.boards.findIndex((board) => board.id === selected);
			const replacement =
				catalog.boards[Math.max(0, previousIndex)] ??
				catalog.boards[previousIndex - 1] ??
				catalog.boards[0] ??
				null;
			this.deps.preferences.setSelectedBoardId(replacement?.id ?? null);
		} else if (!selected && catalog.boards[0]) {
			this.deps.preferences.setSelectedBoardId(catalog.boards[0].id);
		}
	}

	#applyConflictCatalog(error: unknown): void {
		if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object') return;
		const catalog = normalizeChatBoardCatalog((error.payload as Record<string, unknown>).catalog);
		if (catalog) this.#applyCatalog(catalog);
	}
}
