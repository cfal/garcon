import type { GitDiffTab } from '$lib/api/git.js';
import type {
	GitDiffActionMode,
	GitDiffActionTarget,
	GitLineSelectionKey,
} from '$lib/git/workbench/git-workbench-types.js';

export function encodeLineSelectionKey(key: GitLineSelectionKey): string {
	return [encodeURIComponent(key.filePath), key.tab, key.side, String(key.diffLineIndex)].join('|');
}

export function decodeLineSelectionKey(raw: string): GitLineSelectionKey | null {
	const [encodedFilePath, tab, side, rawIndex] = raw.split('|');
	const diffLineIndex = Number(rawIndex);
	if (!encodedFilePath) return null;
	if (tab !== 'unstaged' && tab !== 'staged') return null;
	if (side !== 'before' && side !== 'after') return null;
	if (!Number.isInteger(diffLineIndex) || diffLineIndex < 0) return null;
	return {
		filePath: decodeURIComponent(encodedFilePath),
		tab,
		side,
		diffLineIndex,
	};
}

export function makeLineSelectionKey(
	filePath: string,
	tab: GitDiffTab,
	side: 'before' | 'after',
	diffLineIndex: number,
): string {
	return encodeLineSelectionKey({ filePath, tab, side, diffLineIndex });
}

export class GitLineSelectionState {
	selectedLineKeys = $state(new Set<string>());
	private targets = new Map<string, GitDiffActionTarget>();

	get hasSelection(): boolean {
		return this.selectedLineKeys.size > 0;
	}

	toggleLineSelection(key: string, target: GitDiffActionTarget): void {
		if (!this.captureTarget(key, target)) return;
		const next = new Set(this.selectedLineKeys);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		this.selectedLineKeys = next;
		this.pruneTargets();
	}

	selectLineRange(
		startKey: string,
		endKey: string,
		allKeys: string[],
		target: GitDiffActionTarget,
	): void {
		const startIndex = allKeys.indexOf(startKey);
		const endIndex = allKeys.indexOf(endKey);
		if (startIndex === -1 || endIndex === -1) return;
		const from = Math.min(startIndex, endIndex);
		const to = Math.max(startIndex, endIndex);
		if (!this.captureTarget(endKey, target)) return;
		const next = new Set(this.selectedLineKeys);
		for (let index = from; index <= to; index++) {
			if (this.captureTarget(allKeys[index], target)) next.add(allKeys[index]);
		}
		this.selectedLineKeys = next;
	}

	clearSelection(): void {
		this.selectedLineKeys = new Set();
		this.targets.clear();
	}

	pruneToFilePaths(paths: Set<string>): void {
		this.selectedLineKeys = new Set(
			Array.from(this.selectedLineKeys).filter((rawKey) => {
				const parsed = decodeLineSelectionKey(rawKey);
				return parsed ? paths.has(parsed.filePath) : false;
			}),
		);
		this.pruneTargets();
	}

	clearSelectionForFile(filePath: string, tab: GitDiffTab): void {
		this.selectedLineKeys = new Set(
			Array.from(this.selectedLineKeys).filter((rawKey) => {
				const parsed = decodeLineSelectionKey(rawKey);
				return !parsed || parsed.filePath !== filePath || parsed.tab !== tab;
			}),
		);
		this.targets.delete(JSON.stringify([filePath, tab]));
	}

	groupSelectedLineIndicesByTarget(mode: GitDiffActionMode): Array<{
		target: GitDiffActionTarget;
		lineIndices: number[];
	}> {
		const grouped = new Map<string, { target: GitDiffActionTarget; lineIndices: number[] }>();
		for (const rawKey of this.selectedLineKeys) {
			const parsed = decodeLineSelectionKey(rawKey);
			if (!parsed) continue;
			const target = this.targets.get(JSON.stringify([parsed.filePath, parsed.tab]));
			if (!target || target.mode !== mode) continue;
			const groupKey = `${parsed.filePath}|${parsed.tab}|${mode}`;
			const existing = grouped.get(groupKey) ?? {
				target,
				lineIndices: [],
			};
			existing.lineIndices.push(parsed.diffLineIndex);
			grouped.set(groupKey, existing);
		}
		return Array.from(grouped.values());
	}

	reset(): void {
		this.clearSelection();
	}

	private pruneTargets(): void {
		const retained = new Set(
			Array.from(this.selectedLineKeys).flatMap((key) => {
				const parsed = decodeLineSelectionKey(key);
				return parsed ? [JSON.stringify([parsed.filePath, parsed.tab])] : [];
			}),
		);
		for (const key of this.targets.keys()) if (!retained.has(key)) this.targets.delete(key);
	}

	private captureTarget(key: string, target: GitDiffActionTarget): boolean {
		const parsed = decodeLineSelectionKey(key);
		if (!parsed || parsed.filePath !== target.filePath || parsed.tab !== target.tab) return false;
		const id = JSON.stringify([parsed.filePath, parsed.tab]);
		const previous = this.targets.get(id);
		if (previous && JSON.stringify(previous) !== JSON.stringify(target)) {
			this.clearSelectionForFile(parsed.filePath, parsed.tab);
		}
		this.targets.set(id, target);
		return true;
	}
}
