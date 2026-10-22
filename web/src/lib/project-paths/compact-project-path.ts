export function formatCompactProjectPath(projectPath: string, maxLength = 40): string {
	if (!projectPath || projectPath.length <= maxLength) return projectPath;
	const segments = projectPath.split('/');
	let result = segments[segments.length - 1] ?? projectPath;
	for (let index = segments.length - 2; index >= 0; index -= 1) {
		const candidate = `${segments[index]}/${result}`;
		if (candidate.length + 4 > maxLength) break;
		result = candidate;
	}
	return `\u2026/${result}`;
}

export interface ProjectPathParts {
	name: string;
	parent: string;
}

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:$/;

// Splits a path into its final segment and the directory containing it.
// Accepts either separator because remote executors may run Windows.
export function splitProjectPath(projectPath: string): ProjectPathParts {
	const trimmed = projectPath.replace(/[\\/]+$/, '');
	// Filesystem roots such as / and C:\ have no parent.
	if (!trimmed || WINDOWS_DRIVE_PATTERN.test(trimmed)) return { name: projectPath, parent: '' };
	const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	if (separatorIndex < 0) return { name: trimmed, parent: '' };
	const parent = trimmed.slice(0, separatorIndex);
	// A root parent keeps its separator, since a bare C: is drive-relative rather than the root.
	const isRoot = !parent || WINDOWS_DRIVE_PATTERN.test(parent);
	return {
		name: trimmed.slice(separatorIndex + 1),
		parent: isRoot ? parent + trimmed[separatorIndex] : parent,
	};
}
