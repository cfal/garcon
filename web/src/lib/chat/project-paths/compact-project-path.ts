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
