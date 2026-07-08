export function normalizedPinnedProjectPath(path: string): string {
	return path.trim();
}

export function isPinnedProjectPath(pinnedProjectPaths: string[], path: string): boolean {
	const normalizedPath = normalizedPinnedProjectPath(path);
	return Boolean(normalizedPath) && pinnedProjectPaths.includes(normalizedPath);
}

export function nextPinnedProjectPaths(pinnedProjectPaths: string[], path: string): string[] {
	const normalizedPath = normalizedPinnedProjectPath(path);
	if (!normalizedPath) return pinnedProjectPaths;
	return isPinnedProjectPath(pinnedProjectPaths, normalizedPath)
		? pinnedProjectPaths.filter((pinnedPath) => pinnedPath !== normalizedPath)
		: [...pinnedProjectPaths, normalizedPath];
}
