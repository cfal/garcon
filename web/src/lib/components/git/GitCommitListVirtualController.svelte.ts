import { tick, untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { GitHistoryCommitListItem } from '$lib/api/git.js';
import type {
	GitHistoryListChange,
	GitHistoryListPosition,
} from '$lib/git/history/git-history.svelte.js';
import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import {
	virtualItems as selectVirtualItems,
	type VirtualItem,
	type VirtualListSnapshot,
	type VirtualRange,
} from '$lib/virt/virtual-list-types.js';

export const GIT_HISTORY_ESTIMATED_ROW_HEIGHT = 64;
export const GIT_HISTORY_VIRTUAL_OVERSCAN = 8;
const FALLBACK_VIEWPORT_HEIGHT = 720;
const FOCUS_MOUNT_ATTEMPTS = 4;
const RESTORE_SETTLE_ATTEMPTS = 8;
const RESTORE_OFFSET_TOLERANCE_PX = 0.5;

interface GitCommitListVirtualControllerOptions {
	get commits(): readonly GitHistoryCommitListItem[];
	get collectionChange(): GitHistoryListChange;
	get viewport(): HTMLDivElement | null;
	get savedPosition(): GitHistoryListPosition;
	onPositionSave(position: GitHistoryListPosition): void;
	onLoadBoundaryReached(): void;
	onUserScrollIntent(): void;
}

type CollectionUpdate = 'unchanged' | 'append' | 'replace' | 'reset';

function nextAnimationFrame(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
		else queueMicrotask(resolve);
	});
}

export function retainedGitHistoryFocusRange(
	range: VirtualRange | null,
	focusedIndex: number | undefined,
): number[] {
	const indexes = range
		? Array.from(
				{ length: range.endIndex - range.startIndex + 1 },
				(_, offset) => range.startIndex + offset,
			)
		: [];
	if (focusedIndex !== undefined && !indexes.includes(focusedIndex)) indexes.push(focusedIndex);
	return indexes.sort((left, right) => left - right);
}

function measureCommitRow(element: HTMLElement, entry: ResizeObserverEntry | undefined): number {
	const boxes = entry?.borderBoxSize;
	const box = Array.isArray(boxes) ? boxes[0] : boxes?.[0];
	const size = box?.blockSize ?? element.getBoundingClientRect().height;
	return Math.round(size > 0 ? size : GIT_HISTORY_ESTIMATED_ROW_HEIGHT);
}

export class GitCommitListVirtualController {
	activeHash = $state<string | null>(null);
	focusedHash = $state<string | null>(null);
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;

	#virt: VirtualListController;
	#virtualCommits: readonly GitHistoryCommitListItem[] = [];
	#indexByHash = new Map<string, number>();
	#virtualScrollElement: HTMLDivElement | null = null;
	#lastCollectionRevision = -1;
	#scrollFrame: number | null = null;
	#loadBoundaryPending = false;
	#focusRequestToken = 0;
	#restoreToken = 0;
	#restoreInProgress = false;
	#restoredViewport: HTMLDivElement | null = null;
	#userInteractedViewports = new WeakSet<HTMLDivElement>();

	constructor(private readonly options: GitCommitListVirtualControllerOptions) {
		const initialPosition = untrack(() => options.savedPosition);
		const initialCommits = untrack(() => options.commits);
		const initialCollectionChange = untrack(() => options.collectionChange);
		this.#replaceIndexModel(initialCommits);
		this.#lastCollectionRevision = initialCollectionChange.revision;
		this.activeHash = this.#resolveInitialActiveHash(initialPosition);
		this.#virt = new VirtualListController({
			initialViewportSize: FALLBACK_VIEWPORT_HEIGHT,
			get overscan() {
				return GIT_HISTORY_VIRTUAL_OVERSCAN;
			},
			get measurementAnchor() {
				return 'geometric' as const;
			},
			measureElement: measureCommitRow,
		});
		this.viewport = this.#virt.viewport;
		this.sizer = this.#virt.sizer;
		this.#applyVirtualSource('replace');

		$effect(() => {
			const commits = options.commits;
			const collectionChange = options.collectionChange;
			const viewport = options.viewport;
			const focusedHash = this.focusedHash;
			untrack(() => this.#updateVirtualizer(commits, collectionChange, viewport, focusedHash));
		});

		$effect(() => {
			const viewport = options.viewport;
			if (!viewport || this.#restoredViewport === viewport) return;
			this.#restoredViewport = viewport;
			if (this.#userInteractedViewports.has(viewport)) return;
			const position = untrack(() => options.savedPosition);
			untrack(() => {
				void this.#restorePosition(viewport, position);
			});
		});

		$effect(() => {
			const viewport = options.viewport;
			if (!viewport) return;
			const handleUserScrollIntent = () => this.noteUserScrollIntent();
			const cancelRestoreForKey = (event: KeyboardEvent) => {
				if (
					event.key === 'ArrowDown' ||
					event.key === 'ArrowUp' ||
					event.key === 'PageDown' ||
					event.key === 'PageUp' ||
					event.key === 'Home' ||
					event.key === 'End'
				) {
					handleUserScrollIntent();
				}
			};
			viewport.addEventListener('wheel', handleUserScrollIntent, { passive: true });
			viewport.addEventListener('touchstart', handleUserScrollIntent, { passive: true });
			viewport.addEventListener('pointerdown', handleUserScrollIntent, { passive: true });
			viewport.addEventListener('keydown', cancelRestoreForKey);
			return () => {
				viewport.removeEventListener('wheel', handleUserScrollIntent);
				viewport.removeEventListener('touchstart', handleUserScrollIntent);
				viewport.removeEventListener('pointerdown', handleUserScrollIntent);
				viewport.removeEventListener('keydown', cancelRestoreForKey);
			};
		});

		$effect(() => {
			return () => {
				this.#focusRequestToken += 1;
				this.#restoreToken += 1;
				if (this.#scrollFrame !== null) {
					cancelAnimationFrame(this.#scrollFrame);
					this.#scrollFrame = null;
					this.#capturePosition(true);
				}
				this.#loadBoundaryPending = false;
				this.#virt.destroy();
			};
		});
	}

	get snapshot(): VirtualListSnapshot {
		return this.#virt.snapshot;
	}

	commitAt(index: number): GitHistoryCommitListItem | undefined {
		return this.#virtualCommits[index];
	}

	renderedItems(snapshot: VirtualListSnapshot): readonly VirtualItem[] {
		const range = snapshot.overscanRange ?? this.#fallbackRange(snapshot);
		const focusedIndex = this.focusedHash ? this.#indexByHash.get(this.focusedHash) : undefined;
		return selectVirtualItems(snapshot, retainedGitHistoryFocusRange(range, focusedIndex));
	}

	item(hash: string): Attachment<HTMLElement> {
		return this.#virt.item(hash);
	}

	noteUserScrollIntent(): void {
		const viewport = this.options.viewport;
		if (!viewport) return;
		this.#userInteractedViewports.add(viewport);
		this.#cancelRestore();
		this.#virt.cancelOwnedScroll();
		this.options.onUserScrollIntent();
	}

	handleScroll = (): void => {
		this.#loadBoundaryPending = true;
		this.#schedulePositionCapture();
	};

	maybeLoadMore(): void {
		this.options.onLoadBoundaryReached();
	}

	activate(hash: string): void {
		if (!this.#indexByHash.has(hash)) return;
		this.activeHash = hash;
		this.#capturePosition(true);
	}

	setFocused(hash: string, focused: boolean): void {
		if (focused) {
			if (!this.#indexByHash.has(hash)) return;
			this.activeHash = hash;
			this.focusedHash = hash;
			return;
		}
		this.#releaseFocus(hash);
	}

	handleRowKeydown(event: KeyboardEvent, hash: string): void {
		const index = this.#indexByHash.get(hash);
		if (index === undefined) return;
		let targetIndex: number;
		switch (event.key) {
			case 'ArrowDown':
				targetIndex = index + 1;
				break;
			case 'ArrowUp':
				targetIndex = index - 1;
				break;
			case 'PageDown':
				targetIndex = index + this.#pageSize;
				break;
			case 'PageUp':
				targetIndex = index - this.#pageSize;
				break;
			case 'Home':
				targetIndex = 0;
				break;
			case 'End':
				targetIndex = this.#virtualCommits.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		void this.#focusIndex(Math.min(this.#virtualCommits.length - 1, Math.max(0, targetIndex)));
	}

	get #pageSize(): number {
		const height = this.options.viewport?.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
		return Math.max(1, Math.floor(height / GIT_HISTORY_ESTIMATED_ROW_HEIGHT));
	}

	#fallbackRange(snapshot: VirtualListSnapshot): VirtualRange | null {
		if (this.#virtualCommits.length === 0) return null;
		const viewport = this.options.viewport;
		const offset = viewport?.scrollTop ?? 0;
		const start = snapshot.positions.itemAtOffset(offset)?.index ?? 0;
		const visibleCount = Math.ceil(
			(viewport?.clientHeight || FALLBACK_VIEWPORT_HEIGHT) / GIT_HISTORY_ESTIMATED_ROW_HEIGHT,
		);
		return {
			startIndex: Math.max(0, start - GIT_HISTORY_VIRTUAL_OVERSCAN),
			endIndex: Math.min(
				this.#virtualCommits.length - 1,
				start + visibleCount + GIT_HISTORY_VIRTUAL_OVERSCAN,
			),
		};
	}

	#schedulePositionCapture(): void {
		if (this.#scrollFrame !== null) return;
		this.#scrollFrame = requestAnimationFrame(() => {
			this.#scrollFrame = null;
			this.#capturePosition();
			if (!this.#loadBoundaryPending) return;
			this.#loadBoundaryPending = false;
			this.options.onLoadBoundaryReached();
		});
	}

	#resolveInitialActiveHash(position: GitHistoryListPosition): string | null {
		if (position.activeHash && this.#indexByHash.has(position.activeHash))
			return position.activeHash;
		if (position.anchorHash && this.#indexByHash.has(position.anchorHash))
			return position.anchorHash;
		return this.#virtualCommits[0]?.hash ?? null;
	}

	#updateVirtualizer(
		commits: readonly GitHistoryCommitListItem[],
		collectionChange: GitHistoryListChange,
		viewport: HTMLDivElement | null,
		_focusedHash: string | null,
	): void {
		const update = this.#updateIndexModel(commits, collectionChange);
		this.#virtualScrollElement = viewport;
		if (update !== 'unchanged') this.#applyVirtualSource(update);

		if (update === 'replace') {
			if (viewport) {
				const position = untrack(() => this.options.savedPosition);
				void this.#restorePosition(viewport, position);
			}
		} else if (update === 'reset' && viewport) {
			this.#resetPosition(viewport);
		}
	}

	#applyVirtualSource(update: Exclude<CollectionUpdate, 'unchanged'>): void {
		const result = this.#virt.apply({
			kind: update === 'reset' ? 'reset-measurements' : 'update',
			keys: this.#virtualCommits.map((commit) => commit.hash),
			estimates: Array.from(
				{ length: this.#virtualCommits.length },
				() => GIT_HISTORY_ESTIMATED_ROW_HEIGHT,
			),
			anchor: { kind: 'none' },
		});
		if (result.kind === 'rejected') {
			console.error(`Git history virtualization rejected source geometry: ${result.reason}`);
		}
	}

	#updateIndexModel(
		commits: readonly GitHistoryCommitListItem[],
		collectionChange: GitHistoryListChange,
	): CollectionUpdate {
		const revisionChanged = collectionChange.revision !== this.#lastCollectionRevision;
		if (!revisionChanged) return 'unchanged';

		let update: CollectionUpdate = collectionChange.kind;
		if (update === 'append' && commits.length >= this.#virtualCommits.length) {
			for (let index = this.#virtualCommits.length; index < commits.length; index += 1) {
				const hash = commits[index]?.hash;
				if (hash) this.#indexByHash.set(hash, index);
			}
			this.#virtualCommits = commits;
		} else {
			if (update === 'append') update = 'replace';
			this.#replaceIndexModel(commits);
		}
		this.#lastCollectionRevision = collectionChange.revision;
		this.#reconcileInteractionKeys();
		return update;
	}

	#replaceIndexModel(commits: readonly GitHistoryCommitListItem[]): void {
		this.#virtualCommits = commits;
		this.#indexByHash = new Map(commits.map((commit, index) => [commit.hash, index] as const));
	}

	#reconcileInteractionKeys(): void {
		if (this.focusedHash && !this.#indexByHash.has(this.focusedHash)) {
			this.focusedHash = null;
			this.#focusRequestToken += 1;
		}
		if (!this.activeHash || !this.#indexByHash.has(this.activeHash)) {
			this.activeHash = this.#virtualCommits[0]?.hash ?? null;
		}
	}

	#capturePosition(preserveMountedActive = false): void {
		if (this.#restoreInProgress) return;
		const viewport = this.options.viewport;
		if (!viewport) return;
		const scrollTop = viewport.scrollTop;
		const snapshot = this.#virt.snapshot;
		const paintedOffset = this.#virt.viewportPosition?.paintedOffset ?? scrollTop;
		const firstVisible = snapshot.positions.itemAtOffset(paintedOffset);
		const commit = firstVisible ? this.#virtualCommits[firstVisible.index] : undefined;
		const activeMounted = this.activeHash
			? viewport.querySelector(`[data-git-history-commit-hash="${CSS.escape(this.activeHash)}"]`)
			: null;
		if (!this.focusedHash && commit && (!preserveMountedActive || !activeMounted)) {
			this.activeHash = commit.hash;
		}
		this.options.onPositionSave({
			scrollTop,
			anchorHash: commit?.hash ?? null,
			anchorOffset: firstVisible ? firstVisible.start - paintedOffset : 0,
			activeHash: this.activeHash,
		});
	}

	async #restorePosition(
		viewport: HTMLDivElement,
		position: GitHistoryListPosition,
	): Promise<void> {
		const token = ++this.#restoreToken;
		this.#restoreInProgress = true;
		try {
			const anchorHash = position.anchorHash;
			if (!anchorHash) {
				const offset = Math.max(0, position.scrollTop);
				if (Math.abs(viewport.scrollTop - offset) > RESTORE_OFFSET_TOLERANCE_PX) {
					this.#scrollToOffset(offset);
				}
				return;
			}
			const index = this.#indexByHash.get(anchorHash);
			if (index === undefined) {
				this.#resetPosition(viewport);
				return;
			}

			this.#virt.scrollToAnchor(anchorHash, position.anchorOffset);
			for (let attempt = 0; attempt < RESTORE_SETTLE_ATTEMPTS; attempt += 1) {
				await tick();
				await nextAnimationFrame();
				if (
					token !== this.#restoreToken ||
					this.options.viewport !== viewport ||
					this.#indexByHash.get(anchorHash) !== index
				) {
					return;
				}

				const anchorItem = this.#virt.snapshot.positions.itemAt(index);
				if (!anchorItem) return;
				const paintedOffset = this.#virt.viewportPosition?.paintedOffset ?? viewport.scrollTop;
				const offsetError = anchorItem.start - paintedOffset - position.anchorOffset;
				if (Math.abs(offsetError) <= RESTORE_OFFSET_TOLERANCE_PX) return;
				this.#scrollToOffset(Math.max(0, viewport.scrollTop + offsetError));
			}
		} finally {
			if (token === this.#restoreToken) {
				this.#restoreInProgress = false;
				this.#schedulePositionCapture();
			}
		}
	}

	#resetPosition(_viewport: HTMLDivElement): void {
		this.#cancelRestore();
		this.#scrollToOffset(0);
		this.activeHash = this.#virtualCommits[0]?.hash ?? null;
		this.focusedHash = null;
		this.options.onPositionSave({
			scrollTop: 0,
			anchorHash: this.#virtualCommits[0]?.hash ?? null,
			anchorOffset: 0,
			activeHash: this.activeHash,
		});
	}

	#scrollToOffset(offset: number): void {
		const firstHash = this.#virtualCommits[0]?.hash;
		if (firstHash) this.#virt.scrollToAnchor(firstHash, -offset);
	}

	#cancelRestore(): void {
		this.#restoreToken += 1;
		this.#restoreInProgress = false;
	}

	async #focusIndex(index: number): Promise<void> {
		const commit = this.#virtualCommits[index];
		if (!commit) return;
		const token = ++this.#focusRequestToken;
		this.#cancelRestore();
		this.activeHash = commit.hash;
		this.focusedHash = commit.hash;
		this.#scrollIndexIntoView(index);

		for (let attempt = 0; attempt < FOCUS_MOUNT_ATTEMPTS; attempt += 1) {
			await tick();
			await nextAnimationFrame();
			if (
				token !== this.#focusRequestToken ||
				this.options.viewport !== this.#virtualScrollElement
			) {
				return;
			}
			const button = this.options.viewport?.querySelector<HTMLButtonElement>(
				`[data-git-history-commit-hash="${CSS.escape(commit.hash)}"] [data-git-history-commit-row]`,
			);
			if (button) {
				button.focus({ preventScroll: true });
				return;
			}
		}
		this.#releaseFocus(commit.hash);
	}

	#scrollIndexIntoView(index: number): void {
		const viewport = this.options.viewport;
		const item = this.#virt.snapshot.positions.itemAt(index);
		if (!viewport || !item) return;
		const offset = this.#virt.viewportPosition?.paintedOffset ?? viewport.scrollTop;
		const viewportEnd = offset + (viewport.clientHeight || FALLBACK_VIEWPORT_HEIGHT);
		if (item.end > viewportEnd) {
			this.#virt.scrollToIndex(index, { align: 'end' });
		} else if (item.start < offset) {
			this.#virt.scrollToIndex(index, { align: 'start' });
		}
	}

	#releaseFocus(hash: string): void {
		if (this.focusedHash === hash) {
			this.focusedHash = null;
			this.#schedulePositionCapture();
		}
	}
}
