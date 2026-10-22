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

// Splits a path into its final segment and the directory containing it.
// Accepts either separator because remote executors may run Windows.
export function splitProjectPath(projectPath: string): ProjectPathParts {
	const trimmed = projectPath.replace(/(?<=.)[\\/]+$/, '');
	const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	if (separatorIndex < 0 || separatorIndex === trimmed.length - 1) {
		return { name: trimmed, parent: '' };
	}
	return {
		name: trimmed.slice(separatorIndex + 1),
		parent: trimmed.slice(0, separatorIndex) || trimmed.slice(0, 1),
	};
}
