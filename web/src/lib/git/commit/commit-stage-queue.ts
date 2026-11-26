import type { QuickCommitStageMode } from './commit-tree-reconciliation.js';

export interface QuickCommitPathIntent {
	path: string;
	desiredSelected: boolean;
	actualSelected: boolean;
	isRunning: boolean;
	runningMode: QuickCommitStageMode | null;
	error: string | null;
}

export interface QuickCommitStageBatch {
	mode: QuickCommitStageMode;
	paths: string[];
}

export class CommitStageQueue {
	private paths = new Set<string>();
	private forced = new Set<string>();
	private resolveSettled: (() => void) | null = null;
	settled: Promise<void> | null = null;

	get size(): number {
		return this.paths.size;
	}

	has(path: string): boolean {
		return this.paths.has(path);
	}

	enqueue(item: QuickCommitPathIntent, desired: boolean, force: boolean): boolean {
		if (!force && item.actualSelected === desired && !item.isRunning) return false;
		this.paths.add(item.path);
		if (force) this.forced.add(item.path);
		this.settled ??= new Promise((resolve) => {
			this.resolveSettled = resolve;
		});
		return true;
	}

	takeBatch(
		intents: Readonly<Record<string, QuickCommitPathIntent>>,
	): QuickCommitStageBatch | null {
		let mode: QuickCommitStageMode | null = null;
		const paths: string[] = [];
		for (const path of this.paths) {
			const item = intents[path];
			const nextMode = !item
				? null
				: this.forced.has(path)
					? 'stage'
					: item.desiredSelected === item.actualSelected
						? null
						: item.desiredSelected
							? 'stage'
							: 'unstage';
			if (nextMode && mode && nextMode !== mode) continue;
			this.paths.delete(path);
			this.forced.delete(path);
			if (!nextMode) continue;
			mode = nextMode;
			paths.push(path);
		}
		return mode ? { mode, paths } : null;
	}

	removeFailed(batch: QuickCommitStageBatch, uncertain: boolean): Set<string> {
		const failed = new Set(uncertain ? [...batch.paths, ...this.paths] : batch.paths);
		for (const path of failed) {
			this.paths.delete(path);
			this.forced.delete(path);
		}
		return failed;
	}

	finish(hasPending: boolean): void {
		if (hasPending || this.size > 0) return;
		this.resolveSettled?.();
		this.settled = null;
		this.resolveSettled = null;
	}

	reset(): void {
		this.paths.clear();
		this.forced.clear();
		this.finish(false);
	}
}
