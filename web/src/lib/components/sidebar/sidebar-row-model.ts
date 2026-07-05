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
	groupNestedProjectPaths?: boolean;
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

interface SidebarProjectGroup {
	projectKey: string;
	projectPath: string;
}

interface NormalizedProjectPath {
	originalPath: string;
	normalizedPath: string;
}

interface ProjectGroupingContext {
	groupForProjectPath(projectPath: string): SidebarProjectGroup;
	distinctProjectPathCount(projectKey: string): number;
}

function exactProjectGroup(projectPath: string): SidebarProjectGroup {
	return {
		projectKey: sidebarProjectKey(projectPath),
		projectPath,
	};
}

function normalizeProjectPathForGrouping(projectPath: string): string {
	const trimmed = projectPath.trim().replace(/\\/g, '/');
	if (!trimmed) return '';
	const collapsed = trimmed.replace(/\/+/g, '/');
	if (collapsed === '/') return '/';
	const withoutTrailingSlash = collapsed.replace(/\/+$/g, '');
	return withoutTrailingSlash.replace(/^([A-Za-z]:)/, (drive) => drive.toLowerCase());
}

function isProjectPathAncestor(ancestorPath: string, descendantPath: string): boolean {
	if (!ancestorPath || !descendantPath) return false;
	if (ancestorPath === descendantPath) return true;
	const prefix = ancestorPath.endsWith('/') ? ancestorPath : `${ancestorPath}/`;
	return descendantPath.startsWith(prefix);
}

function createExactProjectGroupingContext(chats: ChatSessionRecord[]): ProjectGroupingContext {
	const distinctProjectPathsByKey = new Map<string, Set<string>>();
	for (const chat of chats) {
		const group = exactProjectGroup(chat.projectPath);
		const distinctPaths = distinctProjectPathsByKey.get(group.projectKey) ?? new Set<string>();
		distinctPaths.add(chat.projectPath);
		distinctProjectPathsByKey.set(group.projectKey, distinctPaths);
	}

	return {
		groupForProjectPath: exactProjectGroup,
		distinctProjectPathCount(projectKey) {
			return distinctProjectPathsByKey.get(projectKey)?.size ?? 0;
		},
	};
}

function createNestedProjectGroupingContext(chats: ChatSessionRecord[]): ProjectGroupingContext {
	const projectsByNormalizedPath = new Map<string, NormalizedProjectPath>();
	for (const chat of chats) {
		const normalizedPath = normalizeProjectPathForGrouping(chat.projectPath);
		if (projectsByNormalizedPath.has(normalizedPath)) continue;
		projectsByNormalizedPath.set(normalizedPath, {
			originalPath: chat.projectPath,
			normalizedPath,
		});
	}

	const projects = Array.from(projectsByNormalizedPath.values()).sort(
		(left, right) => left.normalizedPath.length - right.normalizedPath.length,
	);
	const groupPathByNormalizedPath = new Map<string, string>();
	const distinctProjectPathsByGroupKey = new Map<string, Set<string>>();

	for (const project of projects) {
		const group =
			(project.normalizedPath &&
				projects.find((candidate) =>
					isProjectPathAncestor(candidate.normalizedPath, project.normalizedPath),
				)) ||
			project;
		groupPathByNormalizedPath.set(project.normalizedPath, group.originalPath);
	}

	for (const project of projects) {
		const groupPath = groupPathByNormalizedPath.get(project.normalizedPath) ?? project.originalPath;
		const groupKey = sidebarProjectKey(groupPath);
		const distinctProjectPaths = distinctProjectPathsByGroupKey.get(groupKey) ?? new Set<string>();
		distinctProjectPaths.add(project.normalizedPath);
		distinctProjectPathsByGroupKey.set(groupKey, distinctProjectPaths);
	}

	return {
		groupForProjectPath(projectPath) {
			const normalizedPath = normalizeProjectPathForGrouping(projectPath);
			const groupPath = groupPathByNormalizedPath.get(normalizedPath) ?? projectPath;
			return exactProjectGroup(groupPath);
		},
		distinctProjectPathCount(projectKey) {
			return distinctProjectPathsByGroupKey.get(projectKey)?.size ?? 0;
		},
	};
}

function createProjectGroupingContext(
	chats: ChatSessionRecord[],
	groupNestedProjectPaths: boolean,
): ProjectGroupingContext {
	return groupNestedProjectPaths
		? createNestedProjectGroupingContext(chats)
		: createExactProjectGroupingContext(chats);
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

function projectOrderFromDisplayedChats(
	chats: ChatSessionRecord[],
	grouping: ProjectGroupingContext,
): string[] {
	const seen = new Map<string, ProjectOrderEntry>();
	for (const [index, chat] of chats.entries()) {
		const group = grouping.groupForProjectPath(chat.projectPath);
		const key = group.projectKey;
		if (seen.has(key)) continue;
		const sortLabel = projectSortLabel(group.projectPath);
		seen.set(key, {
			key,
			sortLabel,
			sortLabelLower: sortLabel.toLowerCase(),
			firstSeenIndex: index,
		});
	}
	return Array.from(seen.values())
		.sort(compareProjectOrderEntry)
		.map((entry) => entry.key);
}

function createChatRow(
	chat: ChatSessionRecord,
	list: ChatOrderList,
	reorderScopeKey: string,
	reorderScopeIds: string[],
	group: SidebarProjectGroup = exactProjectGroup(chat.projectPath),
	showProjectPathInGroup = false,
): SidebarVirtualChatRow {
	return {
		type: 'chat',
		key: `${list}:${chat.id}`,
		chat,
		list,
		isPinned: list === 'pinned',
		isArchived: list === 'archived',
		projectPath: chat.projectPath,
		groupProjectKey: group.projectKey,
		groupProjectPath: group.projectPath,
		showProjectPathInGroup,
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
	const grouping = createProjectGroupingContext(
		input.displayedChats,
		Boolean(input.groupNestedProjectPaths),
	);
	const projectKeys = input.groupByProject
		? projectOrderFromDisplayedChats(input.displayedChats, grouping)
		: [];

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
		const group = grouping.groupForProjectPath(chat.projectPath);
		const key = group.projectKey;
		if (!projectPathByKey.has(key)) projectPathByKey.set(key, group.projectPath);
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
			const project = grouping.groupForProjectPath(chat.projectPath).projectKey;
			const scopeIds = scopeIdsByProject.get(project) ?? [];
			scopeIds.push(chat.id);
			scopeIdsByProject.set(project, scopeIds);
		}

		for (const project of projectKeys) {
			const scopeIds = scopeIdsByProject.get(project) ?? [];
			for (const chatId of scopeIds) {
				const chat = displayed.byId[list].get(chatId);
				if (!chat) continue;
				const group = grouping.groupForProjectPath(chat.projectPath);
				const showProjectPathInGroup = grouping.distinctProjectPathCount(group.projectKey) > 1;
				projectRowsByKey
					.get(project)
					?.push(
						createChatRow(
							chat,
							list,
							`${list}:project:${project}`,
							scopeIds,
							group,
							showProjectPathInGroup,
						),
					);
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

export function buildSidebarProjectKeys(input: {
	displayedChats: ChatSessionRecord[];
	groupNestedProjectPaths?: boolean;
}): string[] {
	const grouping = createProjectGroupingContext(
		input.displayedChats,
		Boolean(input.groupNestedProjectPaths),
	);
	return projectOrderFromDisplayedChats(input.displayedChats, grouping);
}

export function buildSidebarDisplayChatIds(input: {
	displayedChats: ChatSessionRecord[];
	groupByProject: boolean;
	groupNestedProjectPaths?: boolean;
	collapsedProjectKeys?: ReadonlySet<string>;
}): string[] {
	const orders = buildSidebarChatOrderMap(input.displayedChats);
	return buildSidebarRowModel({
		displayedChats: input.displayedChats,
		orders,
		groupByProject: input.groupByProject,
		groupNestedProjectPaths: input.groupNestedProjectPaths,
		collapsedProjectKeys: input.collapsedProjectKeys,
	}).visibleChatIds;
}
