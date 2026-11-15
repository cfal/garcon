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

export function splitNewChatProjects(groups: readonly NewChatProjectGroup[], promoted?: NewChatProject): {
	visible: NewChatProject[];
	overflow: NewChatProject[];
} {
	const entries = groups.flatMap(group => group.paths.map(path => ({ executorId: group.executorId, path })));
	const promotedIndex = promoted ? entries.findIndex(entry => entry.executorId === promoted.executorId
		&& projectPathKey(entry.path) === projectPathKey(promoted.path)) : -1;
	const ordered = promotedIndex < 0 ? entries : [entries[promotedIndex]!, ...entries.filter((_, index) => index !== promotedIndex)];
	return {
		visible: ordered.slice(0, VISIBLE_PROJECT_LIMIT),
		overflow: ordered.slice(VISIBLE_PROJECT_LIMIT),
	};
}
