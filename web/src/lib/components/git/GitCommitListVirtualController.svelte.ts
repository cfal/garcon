import { tick, untrack } from 'svelte';
import { get, type Readable } from 'svelte/store';
import {
	createVirtualizer,
	defaultRangeExtractor,
	observeElementRect,
	type Rect,
	type Range,
	type SvelteVirtualizer,
	type Virtualizer,
} from '@tanstack/svelte-virtual';
import type { GitHistoryCommitListItem } from '$lib/api/git.js';
import type {
	GitHistoryListChange,
	GitHistoryListPosition,
} from '$lib/git/history/git-history.svelte.js';
import { measureVirtualRow } from './git-virtual-row-measurement.js';

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
	range: Range,
	focusedIndex: number | undefined,
): number[] {
	const indexes = defaultRangeExtractor(range);
	if (focusedIndex !== undefined && !indexes.includes(focusedIndex)) indexes.push(focusedIndex);
	return indexes.sort((left, right) => left - right);
}

export class GitCommitListVirtualController {
	activeHash = $state<string | null>(null);
	focusedHash = $state<string | null>(null);
	readonly virtualizer: Readable<SvelteVirtualizer<HTMLElement, HTMLDivElement>>;

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

		this.virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
			count: initialCommits.length,
			getScrollElement: this.#getScrollElement,
			getItemKey: this.#getItemKey,
			estimateSize: this.#estimateSize,
			measureElement: this.#measureElement,
			observeElementRect: this.#observeElementRect,
			initialRect: { width: 0, height: FALLBACK_VIEWPORT_HEIGHT },
			initialOffset: () => this.#estimatedInitialOffset(initialPosition),
			overscan: GIT_HISTORY_VIRTUAL_OVERSCAN,
			onChange: this.#handleVirtualizerChange,
		});

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
			};
		});
	}

	noteUserScrollIntent(): void {
		const viewport = this.options.viewport;
		if (!viewport) return;
		this.#userInteractedViewports.add(viewport);
		this.#cancelRestore();
		this.options.onUserScrollIntent();
	}

	measureRow = (element: HTMLDivElement): { update(): void; destroy(): void } => {
		this.#instance().measureElement(element);
		return {
			update: () => this.#instance().measureElement(element),
			destroy: () => this.#instance().measureElement(null),
		};
	};

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

	#releaseFocus(hash: string): void {
		if (this.focusedHash === hash) {
			this.focusedHash = null;
			this.#schedulePositionCapture();
		}
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

	#getScrollElement = (): HTMLDivElement | null => this.#virtualScrollElement;

	#getItemKey = (index: number): string | number => this.#virtualCommits[index]?.hash ?? index;

	#estimateSize = (): number => GIT_HISTORY_ESTIMATED_ROW_HEIGHT;

	#handleVirtualizerChange = (
		_instance: Virtualizer<HTMLElement, HTMLDivElement>,
		sync: boolean,
	): void => {
		if (!sync) this.#schedulePositionCapture();
	};

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

	#measureElement = (
		element: HTMLDivElement,
		entry: ResizeObserverEntry | undefined,
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
	): number => {
		const measured = measureVirtualRow(element, entry, instance);
		return measured > 0 ? measured : GIT_HISTORY_ESTIMATED_ROW_HEIGHT;
	};

	#observeElementRect = (
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (rect: Rect) => void,
	): (() => void) | undefined =>
		observeElementRect(instance, (rect) => {
			callback(rect.height > 0 ? rect : { ...rect, height: FALLBACK_VIEWPORT_HEIGHT });
		});

	#instance(): SvelteVirtualizer<HTMLElement, HTMLDivElement> {
		return get(this.virtualizer);
	}

	#resolveInitialActiveHash(position: GitHistoryListPosition): string | null {
		if (position.activeHash && this.#indexByHash.has(position.activeHash))
			return position.activeHash;
		if (position.anchorHash && this.#indexByHash.has(position.anchorHash))
			return position.anchorHash;
		return this.#virtualCommits[0]?.hash ?? null;
	}

	#estimatedInitialOffset(position: GitHistoryListPosition): number {
		if (position.anchorHash) {
			const index = this.#indexByHash.get(position.anchorHash);
			return index === undefined
				? 0
				: Math.max(0, index * GIT_HISTORY_ESTIMATED_ROW_HEIGHT - position.anchorOffset);
		}
		return Math.max(0, position.scrollTop);
	}

	#updateVirtualizer(
		commits: readonly GitHistoryCommitListItem[],
		collectionChange: GitHistoryListChange,
		viewport: HTMLDivElement | null,
		focusedHash: string | null,
	): void {
		const update = this.#updateIndexModel(commits, collectionChange);
		this.#virtualScrollElement = viewport;
		const focusedIndex = focusedHash ? this.#indexByHash.get(focusedHash) : undefined;
		const instance = this.#instance();
		instance.setOptions({
			count: commits.length,
			getScrollElement: this.#getScrollElement,
			getItemKey: this.#getItemKey,
			estimateSize: this.#estimateSize,
			measureElement: this.#measureElement,
			observeElementRect: this.#observeElementRect,
			initialRect: { width: 0, height: FALLBACK_VIEWPORT_HEIGHT },
			overscan: GIT_HISTORY_VIRTUAL_OVERSCAN,
			rangeExtractor: (range) => retainedGitHistoryFocusRange(range, focusedIndex),
			onChange: this.#handleVirtualizerChange,
		});

		if (update === 'replace') {
			this.#resetMeasurementsForReplacement(instance, commits);
			if (viewport) {
				const position = untrack(() => this.options.savedPosition);
				void this.#restorePosition(viewport, position);
			}
		} else if (update === 'reset') {
			instance.measure();
			if (viewport) this.#resetPosition(viewport);
		}
	}

	#resetMeasurementsForReplacement(
		instance: SvelteVirtualizer<HTMLElement, HTMLDivElement>,
		commits: readonly GitHistoryCommitListItem[],
	): void {
		const retainedSizes = commits.flatMap((commit) => {
			const size = instance.itemSizeCache.get(commit.hash);
			return size === undefined ? [] : [{ hash: commit.hash, size }];
		});
		instance.measure();
		for (const { hash, size } of retainedSizes) instance.itemSizeCache.set(hash, size);
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
		} else {
			if (update === 'append') update = 'replace';
			this.#replaceIndexModel(commits);
		}
		this.#virtualCommits = commits;
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
		const virtualItems = this.#instance().getVirtualItems();
		const firstVisible = virtualItems.find((item) => item.end > scrollTop) ?? virtualItems.at(-1);
		const commit = firstVisible ? this.#virtualCommits[firstVisible.index] : undefined;
		const activeIndex = this.activeHash ? this.#indexByHash.get(this.activeHash) : undefined;
		const activeIsMounted =
			activeIndex !== undefined && virtualItems.some((item) => item.index === activeIndex);
		if (!this.focusedHash && commit && (!preserveMountedActive || !activeIsMounted)) {
			this.activeHash = commit.hash;
		}
		this.options.onPositionSave({
			scrollTop,
			anchorHash: commit?.hash ?? null,
			anchorOffset: firstVisible ? firstVisible.start - scrollTop : 0,
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
				this.#instance().scrollToOffset(Math.max(0, position.scrollTop));
				return;
			}
			const index = this.#indexByHash.get(anchorHash);
			if (index === undefined) {
				this.#resetPosition(viewport);
				return;
			}

			const instance = this.#instance();
			instance.scrollToIndex(index, { align: 'start' });
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

				const anchorItem = instance.getVirtualItems().find((item) => item.index === index);
				if (!anchorItem) {
					instance.scrollToIndex(index, { align: 'start' });
					continue;
				}
				const offsetError = anchorItem.start - viewport.scrollTop - position.anchorOffset;
				if (Math.abs(offsetError) <= RESTORE_OFFSET_TOLERANCE_PX) return;
				instance.scrollToOffset(Math.max(0, viewport.scrollTop + offsetError));
			}
		} finally {
			if (token === this.#restoreToken) {
				this.#restoreInProgress = false;
				this.#schedulePositionCapture();
			}
		}
	}

	#resetPosition(viewport: HTMLDivElement): void {
		this.#cancelRestore();
		this.#instance().scrollToOffset(0);
		viewport.scrollTop = 0;
		this.activeHash = this.#virtualCommits[0]?.hash ?? null;
		this.focusedHash = null;
		this.options.onPositionSave({
			scrollTop: 0,
			anchorHash: this.#virtualCommits[0]?.hash ?? null,
			anchorOffset: 0,
			activeHash: this.activeHash,
		});
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
		this.#instance().scrollToIndex(index, { align: 'auto' });

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
}
