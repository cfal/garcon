import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import { chatActivityTimeMs } from '$shared/chat-order-sort';

export interface SidebarBranch {
	parentId: string | null;
	children: string[];
	activity: number;
	descendants: number;
	unread: number;
	processing: number;
	start: number;
	end: number;
}

export interface SidebarDelegationForest {
	branches: Map<string, SidebarBranch>;
	roots: string[];
	preorder: readonly string[];
	ambiguousIds: Set<string>;
	contains(rootId: string, chatId: string): boolean;
}

export function buildSidebarDelegationForest(
	chats: readonly ChatSessionRecord[],
	options: { nestDelegatedChats: boolean; separateArchivedBranches?: boolean },
): SidebarDelegationForest {
	const byId = new Map(chats.map((chat) => [chat.id, chat]));
	const branches = new Map<string, SidebarBranch>();
	for (const chat of byId.values()) {
		const parent = options.nestDelegatedChats ? chat.parentChatId : null;
		branches.set(chat.id, {
			parentId: parent && byId.has(parent) ? parent : null,
			children: [],
			activity: chatActivityTimeMs(chat),
			descendants: 0,
			unread: Number(chat.isUnread),
			processing: Number(chat.isProcessing),
			start: 0,
			end: 0,
		});
	}
	const visited = new Set<string>();
	const ambiguousIds = new Set<string>();
	for (const id of branches.keys()) {
		const path: string[] = [];
		const positions = new Map<string, number>();
		let current: string | null = id;
		while (current !== null && !visited.has(current)) {
			const cycleStart = positions.get(current);
			if (cycleStart !== undefined) {
				const cycle = path.slice(cycleStart);
				let first = cycle[0];
				for (const member of cycle) {
					ambiguousIds.add(member);
					if (member < first) first = member;
				}
				branches.get(first)!.parentId = null;
				break;
			}
			positions.set(current, path.length);
			path.push(current);
			current = branches.get(current)!.parentId;
		}
		for (const member of path) visited.add(member);
	}
	const roots: string[] = [];
	for (const [id, branch] of branches) {
		if (branch.parentId === null) roots.push(id);
		else branches.get(branch.parentId)!.children.push(id);
	}
	if (options.nestDelegatedChats && options.separateArchivedBranches) {
		const pending = [...roots];
		while (pending.length) {
			const id = pending.pop()!;
			// Archived branches retain all descendants, regardless of their own archive state.
			if (byId.get(id)!.isArchived) continue;
			const branch = branches.get(id)!;
			branch.children = branch.children.filter((childId) => {
				if (byId.get(childId)!.isArchived) {
					branches.get(childId)!.parentId = null;
					roots.push(childId);
					return false;
				}
				pending.push(childId);
				return true;
			});
		}
	}
	const traversal: string[] = [];
	const stack = [...roots].reverse();
	while (stack.length) {
		const id = stack.pop()!;
		const branch = branches.get(id)!;
		branch.start = traversal.length;
		traversal.push(id);
		for (let index = branch.children.length - 1; index >= 0; index--)
			stack.push(branch.children[index]);
	}
	for (let index = traversal.length - 1; index >= 0; index--) {
		const branch = branches.get(traversal[index])!;
		branch.end = branch.start + branch.descendants + 1;
		if (branch.parentId === null) continue;
		const parent = branches.get(branch.parentId)!;
		parent.activity = Math.max(parent.activity, branch.activity);
		parent.descendants += branch.descendants + 1;
		parent.unread += branch.unread;
		parent.processing += branch.processing;
	}
	return {
		branches,
		roots,
		preorder: traversal,
		ambiguousIds,
		contains(rootId, chatId) {
			const root = branches.get(rootId);
			const chat = branches.get(chatId);
			return Boolean(root && chat && root.start <= chat.start && chat.start < root.end);
		},
	};
}
