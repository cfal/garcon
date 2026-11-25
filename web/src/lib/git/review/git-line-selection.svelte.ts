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

function targetKey(filePath: string, tab: GitDiffTab): string {
	return `${tab}\0${filePath}`;
}

function sameProvenance(a: GitDiffActionTarget, b: GitDiffActionTarget): boolean {
	return (
		a.mode === b.mode &&
		a.contextLines === b.contextLines &&
		a.proof.bodyFingerprint === b.proof.bodyFingerprint &&
		a.proof.patchDigest === b.proof.patchDigest &&
		a.proof.document.documentId === b.proof.document.documentId &&
		a.proof.document.executorId === b.proof.document.executorId &&
		a.proof.document.instanceId === b.proof.document.instanceId
	);
}

export class GitLineSelectionState {
	selectedLineKeys = $state.raw(new Set<string>());
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
			const key = allKeys[index];
			const parsed = decodeLineSelectionKey(key);
			if (parsed?.filePath === target.filePath && parsed.tab === target.tab) next.add(key);
		}
		this.selectedLineKeys = next;
	}

	clearSelection(): void {
		if (this.hasSelection) this.selectedLineKeys = new Set();
		this.targets.clear();
	}

	pruneToFilePaths(paths: Set<string>): void {
		const previous = this.selectedLineKeys;
		let next: Set<string> | undefined;
		for (const key of previous) {
			const parsed = decodeLineSelectionKey(key);
			if (parsed && paths.has(parsed.filePath)) continue;
			(next ??= new Set(previous)).delete(key);
		}
		if (!next) return;
		this.selectedLineKeys = next;
		this.pruneTargets();
	}

	clearSelectionForFile(filePath: string, tab: GitDiffTab): void {
		this.selectedLineKeys = new Set(
			Array.from(this.selectedLineKeys).filter((rawKey) => {
				const parsed = decodeLineSelectionKey(rawKey);
				return !parsed || parsed.filePath !== filePath || parsed.tab !== tab;
			}),
		);
		this.targets.delete(targetKey(filePath, tab));
	}

	groupSelectedLineIndicesByTarget(mode: GitDiffActionMode): Array<{
		target: GitDiffActionTarget;
		lineIndices: number[];
	}> {
		const grouped = new Map<string, { target: GitDiffActionTarget; lineIndices: number[] }>();
		for (const rawKey of this.selectedLineKeys) {
			const parsed = decodeLineSelectionKey(rawKey);
			if (!parsed) continue;
			const groupKey = targetKey(parsed.filePath, parsed.tab);
			const target = this.targets.get(groupKey);
			if (!target || target.mode !== mode) continue;
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
				return parsed ? [targetKey(parsed.filePath, parsed.tab)] : [];
			}),
		);
		for (const key of this.targets.keys()) if (!retained.has(key)) this.targets.delete(key);
	}

	private captureTarget(key: string, target: GitDiffActionTarget): boolean {
		const parsed = decodeLineSelectionKey(key);
		if (!parsed || parsed.filePath !== target.filePath || parsed.tab !== target.tab) return false;
		const id = targetKey(parsed.filePath, parsed.tab);
		const previous = this.targets.get(id);
		if (previous && !sameProvenance(previous, target)) {
			this.clearSelectionForFile(parsed.filePath, parsed.tab);
		}
		this.targets.set(id, target);
		return true;
	}
}
