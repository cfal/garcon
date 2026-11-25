import { tick } from 'svelte';
import type { ChatBoard } from '$shared/chat-boards';
import type {
	ChatBoardFocusTarget,
	ChatBoardPresentationBand,
} from './chat-board-focus-controller.js';
import type { ChatBoardFocusController } from './chat-board-focus-controller.js';
import type { ChatBoardPanelMemory } from './chat-board-panel-memory.js';
import { getSurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';

interface ViewportOptions {
	memory: ChatBoardPanelMemory;
	focus: ChatBoardFocusController;
	catalogBoards: () => readonly ChatBoard[];
	selectedBoardId: () => string | undefined;
	activeColumnId: () => string | null;
}

export class ChatBoardViewportState {
	#pendingLaneScrollWrites = new Map<string, number>();
	#pendingHostScrollRestore: ReadonlyMap<string, number> | null;
	#hostFocusTarget = $state<ChatBoardFocusTarget | null>(null);
	#remountFocusTarget = $state<ChatBoardFocusTarget | null>(null);
	#hostFocusRestorePending: boolean;
	#hostFocusRestoreCanceled = false;
	#laneScrollWriteFrame: number | null = null;
	#laneRemountGeneration = 0;
	#hostRestoreGeneration = 0;
	#pendingLaneScrollRestore: {
		readonly generation: number;
		readonly targets: ReadonlyMap<string, number>;
	} | null = null;
	root = $state<HTMLElement | null>(null);
	presentationBand = $state<ChatBoardPresentationBand>('medium');
	readonly #validLaneScrollKeys = $derived.by(() =>
		new Set(
			this.options
				.catalogBoards()
				.flatMap((board) =>
					board.columns.map((column) => this.#laneScrollKey(board.id, column.id)),
				),
		),
	);

	constructor(private readonly options: ViewportOptions) {
		const frameBridge = getSurfaceFrameBridge();
		const offsets = options.memory.laneScrollOffsets;
		this.#pendingHostScrollRestore = offsets.size > 0 ? new Map(offsets) : null;
		this.#hostFocusTarget = options.memory.focusTarget;
		this.#hostFocusRestorePending = options.memory.focusTarget !== null;
		$effect(() => {
			this.options.focus.setRoot(this.root);
		});

		// Supplies bookmark-aware focus while the workspace replaces presentation hosts.
		$effect(() =>
			frameBridge.provideRenderer({
				attach: () => {},
				detach: () => {},
				focusPrimary: () => this.#restorePrimaryFocus(),
			}),
		);

		$effect(() => {
			const root = this.root;
			if (!root) return;
			const generation = ++this.#hostRestoreGeneration;
			const rememberFocus = (event: FocusEvent) => {
				const target = event.target;
				if (!(target instanceof HTMLElement)) return;
				if (root.contains(target)) {
					const focusTarget = this.options.focus.captureFocusTarget(target);
					if (focusTarget || !this.#hostFocusTarget) this.options.memory.focusTarget = focusTarget;
					return;
				}
				if (!this.#hostFocusTarget && !target.closest('[data-chat-board-panel]')) {
					this.options.memory.focusTarget = null;
				}
			};
			const cancelFocusRestore = () => {
				if (!this.#hostFocusRestorePending) return;
				this.#hostFocusRestoreCanceled = true;
				this.#hostFocusTarget = null;
			};
			document.addEventListener('focusin', rememberFocus, true);
			document.addEventListener('pointerdown', cancelFocusRestore, true);
			document.addEventListener('keydown', cancelFocusRestore, true);
			void this.#restoreAfterHostMount(generation);
			return () => {
				this.#hostRestoreGeneration += 1;
				this.#pendingLaneScrollRestore = null;
				document.removeEventListener('focusin', rememberFocus, true);
				document.removeEventListener('pointerdown', cancelFocusRestore, true);
				document.removeEventListener('keydown', cancelFocusRestore, true);
				this.#discardPendingLaneScrollWrites();
			};
		});

		$effect(() => {
			const validKeys = this.#validLaneScrollKeys;
			for (const key of this.options.memory.laneScrollOffsets.keys()) {
				if (!validKeys.has(key)) this.options.memory.laneScrollOffsets.delete(key);
			}
		});

		$effect(() => {
			if (!this.root || typeof ResizeObserver === 'undefined') return;
			const observer = new ResizeObserver(([entry]) => {
				const width = entry?.contentRect.width ?? this.root?.clientWidth ?? 0;
				const nextBand = this.#presentationBandForWidth(width);
				if (nextBand === this.presentationBand) return;
				const generation = this.#beginLaneRemount();
				this.options.focus.preparePresentationChange(nextBand, this.options.activeColumnId());
				this.#remountFocusTarget = this.options.focus.pendingTarget;
				this.presentationBand = nextBand;
				void this.#restoreAfterLaneRemount(generation);
			});
			observer.observe(this.root);
			return () => observer.disconnect();
		});
	}

	remountLanes(select: () => void): void {
		const generation = this.#beginLaneRemount();
		select();
		void this.#restoreAfterLaneRemount(generation);
	}

	#laneScrollKey(boardId: string, columnId: string): string {
		return `${boardId}:${columnId}`;
	}

	laneScrollTop(boardId: string, columnId: string): number {
		return this.options.memory.laneScrollOffsets.get(this.#laneScrollKey(boardId, columnId)) ?? 0;
	}

	pinnedOccurrenceKey(columnId: string): string | null {
		const target = this.#hostFocusTarget ?? this.#remountFocusTarget;
		return target?.kind === 'occurrence' && target.columnId === columnId
			? target.occurrenceKey
			: null;
	}

	#presentationBandForWidth(width: number): ChatBoardPresentationBand {
		if (width < 560) return 'narrow';
		if (width < 900) return 'medium';
		return 'wide';
	}

	#isPresentationChangePending(): boolean {
		// Chromium can reset scrollTop before ResizeObserver commits the new band.
		const width = this.root?.getBoundingClientRect().width ?? 0;
		return width > 0 && this.#presentationBandForWidth(width) !== this.presentationBand;
	}

	rememberLaneScroll = (boardId: string, columnId: string, scrollTop: number): void => {
		const key = this.#laneScrollKey(boardId, columnId);
		if (this.#pendingHostScrollRestore?.has(key)) return;
		if (this.#pendingLaneScrollRestore?.targets.has(key)) return;
		if (!this.#validLaneScrollKeys.has(key)) return;
		this.#pendingLaneScrollWrites.set(key, scrollTop);
		if (this.#laneScrollWriteFrame !== null) return;
		this.#laneScrollWriteFrame = requestAnimationFrame(() => this.#flushPendingLaneScrollWrites());
	};

	#flushPendingLaneScrollWrites(): void {
		if (this.#laneScrollWriteFrame !== null) cancelAnimationFrame(this.#laneScrollWriteFrame);
		this.#laneScrollWriteFrame = null;
		if (this.#isPresentationChangePending()) {
			this.#pendingLaneScrollWrites.clear();
			return;
		}
		for (const [key, scrollTop] of this.#pendingLaneScrollWrites) {
			if (this.#pendingHostScrollRestore?.has(key)) continue;
			if (this.#pendingLaneScrollRestore?.targets.has(key)) continue;
			if (this.#validLaneScrollKeys.has(key))
				this.options.memory.laneScrollOffsets.set(key, scrollTop);
		}
		this.#pendingLaneScrollWrites.clear();
	}

	#discardPendingLaneScrollWrites(): void {
		if (this.#laneScrollWriteFrame !== null) cancelAnimationFrame(this.#laneScrollWriteFrame);
		this.#laneScrollWriteFrame = null;
		this.#pendingLaneScrollWrites.clear();
	}

	#beginLaneRemount(): number {
		this.#discardPendingLaneScrollWrites();
		const generation = ++this.#laneRemountGeneration;
		this.#pendingLaneScrollRestore = {
			generation,
			targets: new Map(
				this.#pendingLaneScrollRestore?.targets ?? this.options.memory.laneScrollOffsets,
			),
		};
		return generation;
	}

	#isCurrentLaneRemount(generation: number): boolean {
		return this.#pendingLaneScrollRestore?.generation === generation;
	}

	#nextAnimationFrame(): Promise<void> {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}

	async #restoreAfterHostMount(generation: number): Promise<void> {
		await tick();
		await this.#nextAnimationFrame();
		await this.#nextAnimationFrame();
		if (generation !== this.#hostRestoreGeneration) return;
		const scrollTargets = this.#pendingHostScrollRestore;
		if (scrollTargets) {
			this.#restoreMountedLaneScrollPositions(scrollTargets);
			await this.#nextAnimationFrame();
			if (generation !== this.#hostRestoreGeneration) return;
			this.#pendingHostScrollRestore = null;
			this.#commitLaneScrollOffsets(scrollTargets);
		}
		if (!this.#hostFocusRestorePending) return;
		this.#hostFocusRestorePending = false;
		const canceled = this.#hostFocusRestoreCanceled;
		this.#hostFocusRestoreCanceled = false;
		const target = this.#hostFocusTarget;
		this.#hostFocusTarget = null;
		if (canceled || !target) return;
		const active = document.activeElement;
		if (active instanceof HTMLElement && active !== document.body) return;
		this.options.focus.restoreFocusTarget(
			target,
			this.presentationBand,
			this.options.activeColumnId(),
		);
	}

	#restorePrimaryFocus(): void {
		let target: ChatBoardFocusTarget | null;
		let canceled = false;
		if (this.#hostFocusRestorePending) {
			this.#hostFocusRestorePending = false;
			canceled = this.#hostFocusRestoreCanceled;
			this.#hostFocusRestoreCanceled = false;
			target = this.#hostFocusTarget;
		} else {
			target = this.options.memory.focusTarget;
		}
		this.#hostFocusTarget = null;
		if (canceled) return;
		if (
			target &&
			this.options.focus.restoreFocusTarget(
				target,
				this.presentationBand,
				this.options.activeColumnId(),
			)
		) {
			return;
		}
		this.options.focus.focusToolbar();
	}

	#restoreMountedLaneScrollPositions(targets: ReadonlyMap<string, number>): void {
		const boardId = this.options.selectedBoardId();
		if (!boardId || !this.root) return;
		for (const viewport of this.root.querySelectorAll<HTMLElement>('[data-chat-board-lane-list]')) {
			const columnId = viewport.dataset.chatBoardLaneList;
			const scrollTop = columnId ? targets.get(this.#laneScrollKey(boardId, columnId)) : undefined;
			if (scrollTop !== undefined) viewport.scrollTop = scrollTop;
		}
	}

	#commitLaneScrollOffsets(targets: ReadonlyMap<string, number>): void {
		for (const [key, scrollTop] of targets) {
			if (this.#validLaneScrollKeys.has(key))
				this.options.memory.laneScrollOffsets.set(key, scrollTop);
		}
	}

	async #restoreAfterLaneRemount(generation: number): Promise<void> {
		await tick();
		if (!this.#isCurrentLaneRemount(generation)) return;
		await this.#nextAnimationFrame();
		if (!this.#isCurrentLaneRemount(generation)) return;
		await this.#nextAnimationFrame();
		const pending = this.#pendingLaneScrollRestore;
		if (pending?.generation !== generation) return;
		this.#restoreMountedLaneScrollPositions(pending.targets);
		await this.#nextAnimationFrame();
		if (!this.#isCurrentLaneRemount(generation)) return;
		this.#pendingLaneScrollRestore = null;
		this.options.focus.completePresentationChange();
		this.#remountFocusTarget = null;
		this.#commitLaneScrollOffsets(pending.targets);
	}
}
