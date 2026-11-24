import { projectPathKey } from '$shared/project-path-preferences';

interface NewChatProjectGroup {
	executorId: string;
	paths: readonly string[];
}

const VISIBLE_PROJECT_LIMIT = 5;

export interface NewChatProject {
	executorId: string;
	path: string;
}

export function newChatProjectKey(project: NewChatProject): string {
	return JSON.stringify([project.executorId, projectPathKey(project.path)]);
}

interface NewChatProjectVisibilityOptions {
	promoted?: readonly NewChatProject[];
	selected?: NewChatProject;
}

export function splitNewChatProjects(
	groups: readonly NewChatProjectGroup[],
	{ promoted = [], selected }: NewChatProjectVisibilityOptions = {},
): {
	visible: NewChatProject[];
	overflow: NewChatProject[];
} {
	const entries = groups.flatMap(group => group.paths.map(path => ({ executorId: group.executorId, path })));
	const eligible = new Map(entries.map(entry => [newChatProjectKey(entry), entry]));
	const promotedEntries = promoted.flatMap(project => {
		const key = newChatProjectKey(project);
		const entry = eligible.get(key);
		eligible.delete(key);
		return entry ? [entry] : [];
	});
	let ordered = [...promotedEntries, ...eligible.values()];
	const selectedIndex = selected ? ordered.findIndex(entry => newChatProjectKey(entry) === newChatProjectKey(selected)) : -1;
	if (selectedIndex >= VISIBLE_PROJECT_LIMIT) {
		ordered = [ordered[selectedIndex]!, ...ordered.filter((_, index) => index !== selectedIndex)];
	}
	return {
		visible: ordered.slice(0, VISIBLE_PROJECT_LIMIT),
		overflow: ordered.slice(VISIBLE_PROJECT_LIMIT),
	};
}
