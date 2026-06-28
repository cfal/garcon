import type { ChatOrderList } from '$lib/api/chats.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type {
	SidebarChatOrderMap,
	SidebarRowModel,
	SidebarVirtualChatRow,
	SidebarVirtualRow,
} from './sidebar-virtual-chat-list';

const chatOrderLists: ChatOrderList[] = ['pinned', 'normal', 'archived'];
const unknownProjectKey = '<unknown-project>';
const unknownProjectSortLabel = 'Unknown project';

interface PartitionedChats {
	byId: Record<ChatOrderList, Map<string, ChatSessionRecord>>;
	hasPinned: boolean;
}

export interface SidebarRowModelInput {
	displayedChats: ChatSessionRecord[];
	orders: SidebarChatOrderMap;
	groupByProject: boolean;
	collapsedProjectKeys?: ReadonlySet<string>;
}

function emptyOrderMap(): SidebarChatOrderMap {
	return { pinned: [], normal: [], archived: [] };
}

function listForChat(chat: ChatSessionRecord): ChatOrderList {
	if (chat.isPinned) return 'pinned';
	if (chat.isArchived) return 'archived';
	return 'normal';
}

export function sidebarProjectKey(projectPath: string): string {
	return projectPath ? `path:${projectPath}` : unknownProjectKey;
}

export function partitionSidebarChats(chats: ChatSessionRecord[]): PartitionedChats {
	const byId: Record<ChatOrderList, Map<string, ChatSessionRecord>> = {
		pinned: new Map(),
		normal: new Map(),
		archived: new Map(),
	};

	for (const chat of chats) {
		byId[listForChat(chat)].set(chat.id, chat);
	}

	return { byId, hasPinned: byId.pinned.size > 0 };
}

export function buildSidebarChatOrderMap(chats: ChatSessionRecord[]): SidebarChatOrderMap {
	const orders = emptyOrderMap();
	for (const chat of chats) {
		orders[listForChat(chat)].push(chat.id);
	}
	return orders;
}

interface ProjectOrderEntry {
	key: string;
	sortLabel: string;
	sortLabelLower: string;
	firstSeenIndex: number;
}

function compareProjectOrderEntry(left: ProjectOrderEntry, right: ProjectOrderEntry): number {
	if (left.sortLabelLower < right.sortLabelLower) return -1;
	if (left.sortLabelLower > right.sortLabelLower) return 1;
	if (left.sortLabel < right.sortLabel) return -1;
	if (left.sortLabel > right.sortLabel) return 1;
	return left.firstSeenIndex - right.firstSeenIndex;
}

function projectSortLabel(projectPath: string): string {
	return projectPath || unknownProjectSortLabel;
}

function projectOrderFromDisplayedChats(chats: ChatSessionRecord[]): string[] {
	const seen = new Map<string, ProjectOrderEntry>();
	for (const [index, chat] of chats.entries()) {
		const key = sidebarProjectKey(chat.projectPath);
		if (seen.has(key)) continue;
		const sortLabel = projectSortLabel(chat.projectPath);
		seen.set(key, {
			key,
			sortLabel,
			sortLabelLower: sortLabel.toLowerCase(),
			firstSeenIndex: index,
		});
	}
	return Array.from(seen.values()).sort(compareProjectOrderEntry).map((entry) => entry.key);
}

function createChatRow(
	chat: ChatSessionRecord,
	list: ChatOrderList,
	reorderScopeKey: string,
	reorderScopeIds: string[],
): SidebarVirtualChatRow {
	return {
		type: 'chat',
		key: `${list}:${chat.id}`,
		chat,
		list,
		isPinned: list === 'pinned',
		isArchived: list === 'archived',
		projectPath: chat.projectPath,
		reorderScopeKey,
		reorderScopeIds,
	};
}

function appendChatRow(
	rows: SidebarVirtualRow[],
	row: SidebarVirtualChatRow,
	visibleOrders: SidebarChatOrderMap,
	visibleChatIds: string[],
	reorderScopesByChatId: Map<string, string[]>,
): void {
	rows.push(row);
	visibleOrders[row.list].push(row.chat.id);
	visibleChatIds.push(row.chat.id);
	reorderScopesByChatId.set(row.chat.id, row.reorderScopeIds);
}

export function buildSidebarRowModel(input: SidebarRowModelInput): SidebarRowModel {
	const displayed = partitionSidebarChats(input.displayedChats);
	const rows: SidebarVirtualRow[] = [];
	const visibleOrders = emptyOrderMap();
	const visibleChatIds: string[] = [];
	const reorderScopesByChatId = new Map<string, string[]>();
	const projectKeys = input.groupByProject ? projectOrderFromDisplayedChats(input.displayedChats) : [];

	if (!input.groupByProject) {
		for (const list of chatOrderLists) {
			const scopeIds = input.orders[list].filter((id) => displayed.byId[list].has(id));
			for (const chatId of scopeIds) {
				const chat = displayed.byId[list].get(chatId);
				if (!chat) continue;
				appendChatRow(
					rows,
					createChatRow(chat, list, `${list}:all`, scopeIds),
					visibleOrders,
					visibleChatIds,
					reorderScopesByChatId,
				);
			}
		}
		return { rows, visibleOrders, visibleChatIds, reorderScopesByChatId, projectKeys };
	}

	const projectPathByKey = new Map<string, string>();
	const projectChatIdsByKey = new Map<string, string[]>();
	const projectRowsByKey = new Map<string, SidebarVirtualChatRow[]>();
	const collapsedProjectKeys = input.collapsedProjectKeys ?? new Set<string>();

	for (const chat of input.displayedChats) {
		const key = sidebarProjectKey(chat.projectPath);
		if (!projectPathByKey.has(key)) projectPathByKey.set(key, chat.projectPath);
		const projectChatIds = projectChatIdsByKey.get(key) ?? [];
		projectChatIds.push(chat.id);
		projectChatIdsByKey.set(key, projectChatIds);
		if (!projectRowsByKey.has(key)) projectRowsByKey.set(key, []);
	}

	for (const list of chatOrderLists) {
		const scopeIdsByProject = new Map<string, string[]>();
		for (const chatId of input.orders[list]) {
			const chat = displayed.byId[list].get(chatId);
			if (!chat) continue;
			const project = sidebarProjectKey(chat.projectPath);
			const scopeIds = scopeIdsByProject.get(project) ?? [];
			scopeIds.push(chat.id);
			scopeIdsByProject.set(project, scopeIds);
		}

		for (const project of projectKeys) {
			const scopeIds = scopeIdsByProject.get(project) ?? [];
			for (const chatId of scopeIds) {
				const chat = displayed.byId[list].get(chatId);
				if (!chat) continue;
				projectRowsByKey
					.get(project)
					?.push(createChatRow(chat, list, `${list}:project:${project}`, scopeIds));
			}
		}
	}

	for (const project of projectKeys) {
		const projectRows = projectRowsByKey.get(project) ?? [];
		const projectChatIds = projectChatIdsByKey.get(project) ?? [];
		if (projectChatIds.length === 0) continue;
		const isCollapsed = collapsedProjectKeys.has(project);
		rows.push({
			type: 'project-header',
			key: `project:${project}`,
			projectKey: project,
			projectPath: projectPathByKey.get(project) ?? '',
			count: projectChatIds.length,
			chatIds: projectChatIds,
			isCollapsed,
		});
		if (isCollapsed) continue;
		for (const row of projectRows) {
			appendChatRow(rows, row, visibleOrders, visibleChatIds, reorderScopesByChatId);
		}
	}

	return { rows, visibleOrders, visibleChatIds, reorderScopesByChatId, projectKeys };
}

export function buildSidebarDisplayChatIds(input: {
	displayedChats: ChatSessionRecord[];
	groupByProject: boolean;
	collapsedProjectKeys?: ReadonlySet<string>;
}): string[] {
	const orders = buildSidebarChatOrderMap(input.displayedChats);
	return buildSidebarRowModel({
		displayedChats: input.displayedChats,
		orders,
		groupByProject: input.groupByProject,
		collapsedProjectKeys: input.collapsedProjectKeys,
	}).visibleChatIds;
}
