export function normalizeProjectPath(projectPath: string): string {
	const trimmed = projectPath.trim().replace(/\\/g, '/');
	if (!trimmed) return '';
	const collapsed = trimmed.replace(/\/+/g, '/');
	if (collapsed === '/') return '/';
	const withoutTrailingSlash = collapsed.replace(/\/+$/g, '');
	return withoutTrailingSlash.replace(/^([A-Za-z]:)/, (drive) => drive.toLowerCase());
}

export function isProjectPathAncestor(ancestorPath: string, descendantPath: string): boolean {
	const ancestor = normalizeProjectPath(ancestorPath);
	const descendant = normalizeProjectPath(descendantPath);
	if (!ancestor || !descendant) return false;
	if (ancestor === descendant) return true;
	const prefix = ancestor.endsWith('/') ? ancestor : `${ancestor}/`;
	return descendant.startsWith(prefix);
}

export function projectPathAndAncestors(projectPath: string): string[] {
	const normalized = normalizeProjectPath(projectPath);
	if (!isAbsoluteProjectPath(normalized)) return [];

	const paths = [normalized];
	let current = normalized;
	while (current !== '/' && !isWindowsDriveRoot(current)) {
		const separatorIndex = current.lastIndexOf('/');
		if (separatorIndex < 0) break;
		current = separatorIndex === 0 ? '/' : current.slice(0, separatorIndex);
		paths.push(current);
	}
	return paths;
}

function isAbsoluteProjectPath(projectPath: string): boolean {
	return projectPath.startsWith('/') || /^[a-z]:($|\/)/.test(projectPath);
}

function isWindowsDriveRoot(projectPath: string): boolean {
	return /^[a-z]:$/.test(projectPath);
}
