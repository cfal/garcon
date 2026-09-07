import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';

export interface GitReviewDisplayConsumer {
	isVisible(): boolean;
	hasOpenCommentComposer(): boolean;
	markContextChangeBlocked(): void;
	apply(diffMode: DiffMode, contextLines: number): void;
}

export class GitReviewDisplaySettingsStore {
	diffMode = $state<DiffMode>('unified');
	contextLines = $state(5);
	#consumers = new Map<string, GitReviewDisplayConsumer>();

	register(surfaceId: string, consumer: GitReviewDisplayConsumer): () => void {
		this.#consumers.set(surfaceId, consumer);
		if (consumer.isVisible()) consumer.apply(this.diffMode, this.contextLines);
		return () => {
			if (this.#consumers.get(surfaceId) === consumer) {
				this.#consumers.delete(surfaceId);
			}
		};
	}

	reconcile(surfaceId: string): void {
		const consumer = this.#consumers.get(surfaceId);
		if (consumer?.isVisible()) consumer.apply(this.diffMode, this.contextLines);
	}

	setDiffMode(mode: DiffMode): void {
		if (mode === this.diffMode) return;
		this.diffMode = mode;
		this.#applyVisible();
	}

	setContextLines(lines: number): boolean {
		const normalized = Math.max(0, Math.round(lines));
		if (normalized === this.contextLines) return true;
		const blockers = [...this.#consumers.values()].filter((consumer) =>
			consumer.hasOpenCommentComposer(),
		);
		if (blockers.length > 0) {
			for (const consumer of this.#consumers.values()) {
				if (consumer.isVisible() || consumer.hasOpenCommentComposer()) {
					consumer.markContextChangeBlocked();
				}
			}
			return false;
		}
		this.contextLines = normalized;
		this.#applyVisible();
		return true;
	}

	#applyVisible(): void {
		for (const consumer of this.#consumers.values()) {
			if (consumer.isVisible()) consumer.apply(this.diffMode, this.contextLines);
		}
	}
}
