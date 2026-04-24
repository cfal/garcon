// Helpers for grouping sidebar chats by workspace (project path).

import type { ChatSessionRecord } from '$lib/types/chat-session';

/** Returns the basename of the project path as the workspace identifier.
 * Chats sharing the same deepest directory end up in the same group. */
export function getWorkspaceName(projectPath: string): string {
	if (!projectPath || projectPath.trim().length === 0) {
		return 'Unassigned';
	}
	const parts = projectPath.split('/').filter(Boolean);
	return parts[parts.length - 1];
}

export interface WorkspaceGroup<T extends { projectPath: string }> {
	name: string;
	projectPath: string;
	chats: T[];
}

/** Groups chats by their basename,
 * preserving the first-seen order of workspace names and the
 * original order of chats within each group. */
export function groupChatsByWorkspace<T extends { projectPath: string }>(
	chats: T[],
): WorkspaceGroup<T>[] {
	const order: string[] = [];
	const groups: WorkspaceGroup<T>[] = [];

	for (const chat of chats) {
		const name = getWorkspaceName(chat.projectPath);
		const idx = order.indexOf(name);
		if (idx === -1) {
			order.push(name);
			groups.push({ name, projectPath: chat.projectPath, chats: [] });
			groups[order.length - 1].chats.push(chat);
			continue;
				}
		groups[idx].chats.push(chat);
	}

	return groups;
}
