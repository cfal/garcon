import { orderedProjectPaths, reconcileProjectPins } from '$shared/project-pins';
import { projectPathKey } from '$shared/project-path-preferences';

export function normalizedPinnedProjectPath(path: string): string {
	return path.trim() ? path : '';
}

function comparePinnedProjectPaths(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

export function sortedPinnedProjectPaths(pinnedProjectPaths: string[]): string[] {
	const seen = new Set<string>();
	const normalizedPaths: string[] = [];
	for (const pinnedPath of pinnedProjectPaths) {
		const normalizedPath = normalizedPinnedProjectPath(pinnedPath);
		if (!normalizedPath || seen.has(normalizedPath)) continue;
		seen.add(normalizedPath);
		normalizedPaths.push(normalizedPath);
	}
	return normalizedPaths.sort(comparePinnedProjectPaths);
}

export function isPinnedProjectPath(pinnedProjectPaths: string[], path: string): boolean {
	const normalizedPath = normalizedPinnedProjectPath(path);
	return (
		Boolean(normalizedPath) && orderedProjectPaths(pinnedProjectPaths)
			.some(pinnedPath => projectPathKey(pinnedPath) === projectPathKey(normalizedPath))
	);
}

export function nextPinnedProjectPaths(pinnedProjectPaths: string[], path: string): string[] {
	const normalizedPath = normalizedPinnedProjectPath(path);
	if (!normalizedPath) return pinnedProjectPaths;
	const current = orderedProjectPaths(pinnedProjectPaths);
	const targetKey = projectPathKey(normalizedPath);
	const next = current.some(pinnedPath => projectPathKey(pinnedPath) === targetKey)
		? current.filter(pinnedPath => projectPathKey(pinnedPath) !== targetKey)
		: [...current, normalizedPath];
	return reconcileProjectPins(current, next, []).pinnedPaths;
}
