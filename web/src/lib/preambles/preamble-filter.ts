import type { Preamble } from '$shared/preambles';

export function matchesPreambleFilter(preamble: Preamble, query: string): boolean {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return true;
	const paths = preamble.scope.type === 'project-paths'
		? preamble.scope.rules.map((rule) => rule.projectPath)
		: [];
	return [preamble.title, preamble.content, ...paths]
		.some((value) => value.toLocaleLowerCase().includes(needle));
}

export function filterPreambles(
	preambles: readonly Preamble[],
	query: string,
): readonly Preamble[] {
	return preambles.filter((preamble) => matchesPreambleFilter(preamble, query));
}
