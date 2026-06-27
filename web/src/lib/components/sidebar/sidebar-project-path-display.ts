export function formatSidebarProjectPath(pathStr: string, maxLen = 40): string {
	if (!pathStr || pathStr.length <= maxLen) return pathStr;
	const segments = pathStr.split('/');
	let result = segments[segments.length - 1] ?? pathStr;
	for (let index = segments.length - 2; index >= 0; index -= 1) {
		const candidate = `${segments[index]}/${result}`;
		if (candidate.length + 4 > maxLen) break;
		result = candidate;
	}
	return `\u2026/${result}`;
}
