export function normalizedPinnedProjectPath(path: string): string {
	return path.trim();
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
	return Boolean(normalizedPath) && sortedPinnedProjectPaths(pinnedProjectPaths).includes(normalizedPath);
}

export function nextPinnedProjectPaths(pinnedProjectPaths: string[], path: string): string[] {
	const normalizedPath = normalizedPinnedProjectPath(path);
	if (!normalizedPath) return pinnedProjectPaths;
	const current = sortedPinnedProjectPaths(pinnedProjectPaths);
	return current.includes(normalizedPath)
		? current.filter((pinnedPath) => pinnedPath !== normalizedPath)
		: sortedPinnedProjectPaths([...current, normalizedPath]);
}
