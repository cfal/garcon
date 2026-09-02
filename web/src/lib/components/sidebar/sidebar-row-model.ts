import type { PersistedChatOrderGroup } from '$shared/chat-order-contracts';
import { chatOrderGroupFor } from '$lib/sidebar/search/chat-order-group.js';
import type { SidebarChatGrouping } from '$lib/stores/local-settings.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { isSidebarChatInactive } from './chat-inactivity';
import { isProjectPathAncestor, normalizeProjectPath } from '$lib/utils/project-path.js';
import {
	sidebarSectionKey,
	type SidebarChatOrderMap,
	type SidebarChatSection,
	type SidebarRowModel,
	type SidebarVirtualChatRow,
	type SidebarVirtualRow,
} from './sidebar-virtual-chat-list';

const chatOrderLists: PersistedChatOrderGroup[] = ['pinned', 'normal', 'archived'];
const unknownProjectKey = '<unknown-project>';
const unknownProjectSortLabel = 'Unknown project';

interface PartitionedChats {
	byId: Record<PersistedChatOrderGroup, Map<string, ChatSessionRecord>>;
	hasPinned: boolean;
}

export interface SidebarRowModelInput {
	displayedChats: ChatSessionRecord[];
	orders: SidebarChatOrderMap;
	grouping: SidebarChatGrouping;
	currentTime: Date;
	groupNestedProjectPaths?: boolean;
	collapsedProjectKeys?: ReadonlySet<string>;
}

function emptyOrderMap(): SidebarChatOrderMap {
	return { pinned: [], normal: [], archived: [] };
}

export function sidebarProjectKey(projectPath: string): string {
	return projectPath ? `path:${projectPath}` : unknownProjectKey;
}

export function partitionSidebarChats(chats: ChatSessionRecord[]): PartitionedChats {
	const byId: Record<PersistedChatOrderGroup, Map<string, ChatSessionRecord>> = {
		pinned: new Map(),
		normal: new Map(),
		archived: new Map(),
	};

	for (const chat of chats) {
		byId[chatOrderGroupFor(chat)].set(chat.id, chat);
	}

	return { byId, hasPinned: byId.pinned.size > 0 };
}

export function buildSidebarChatOrderMap(chats: ChatSessionRecord[]): SidebarChatOrderMap {
	const orders = emptyOrderMap();
	for (const chat of chats) {
		orders[chatOrderGroupFor(chat)].push(chat.id);
	}
	return orders;
}

export type SidebarTimeGroupedPlacement = 'project' | 'inactive' | 'archived';

// Project-and-time placement: pinned chats stay in their project group,
// archived chats always move to the archived section regardless of activity,
// and remaining chats whose last activity is at least three days old move to
// the inactive section instead of their project group.
export function sidebarTimeGroupedPlacement(
	chat: Pick<
		ChatSessionRecord,
		'id' | 'status' | 'isPinned' | 'isArchived' | 'lastActivityAt' | 'createdAt'
	>,
	now: Date,
): SidebarTimeGroupedPlacement {
	if (chat.isPinned) return 'project';
	if (chat.isArchived) return 'archived';
	// Local drafts carry no server timestamps yet represent the newest activity.
	if (chat.status === 'draft') return 'project';
	return isSidebarChatInactive(chat, now) ? 'inactive' : 'project';
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
		const normalizedPath = normalizeProjectPath(chat.projectPath);
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
			const normalizedPath = normalizeProjectPath(projectPath);
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
	list: PersistedChatOrderGroup,
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
	const collapsedProjectKeys = input.collapsedProjectKeys ?? new Set<string>();

	if (input.grouping === 'none') {
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
		return { rows, visibleOrders, visibleChatIds, reorderScopesByChatId, projectKeys: [] };
	}

	const timeGrouped = input.grouping === 'project-and-time';
	const placementByChatId = new Map<string, SidebarTimeGroupedPlacement>();
	if (timeGrouped) {
		for (const chat of input.displayedChats) {
			placementByChatId.set(chat.id, sidebarTimeGroupedPlacement(chat, input.currentTime));
		}
	}
	const inProjectGroup = (chat: ChatSessionRecord): boolean =>
		!timeGrouped || placementByChatId.get(chat.id) === 'project';

	const projectChats = input.displayedChats.filter(inProjectGroup);
	const projectKeys = projectOrderFromDisplayedChats(projectChats, grouping);

	const projectPathByKey = new Map<string, string>();
	const projectChatIdsByKey = new Map<string, string[]>();
	const projectRowsByKey = new Map<string, SidebarVirtualChatRow[]>();

	for (const chat of projectChats) {
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
			if (!chat || !inProjectGroup(chat)) continue;
			const project = grouping.groupForProjectPath(chat.projectPath).projectKey;
			const scopeIds = scopeIdsByProject.get(project) ?? [];
			scopeIds.push(chatId);
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

	if (timeGrouped) {
		for (const section of ['inactive', 'archived'] as const satisfies readonly SidebarChatSection[]) {
			const list: PersistedChatOrderGroup = section === 'inactive' ? 'normal' : 'archived';
			appendSidebarChatSection({
				section,
				list,
				orderedChatIds: input.orders[list],
				byId: displayed.byId[list],
				placementByChatId: placementByChatId,
				collapsedProjectKeys,
				rows,
				visibleOrders,
				visibleChatIds,
				reorderScopesByChatId,
			});
		}
	}

	return { rows, visibleOrders, visibleChatIds, reorderScopesByChatId, projectKeys };
}

function appendSidebarChatSection(input: {
	section: SidebarChatSection;
	list: PersistedChatOrderGroup;
	orderedChatIds: string[];
	byId: Map<string, ChatSessionRecord>;
	placementByChatId: Map<string, SidebarTimeGroupedPlacement>;
	collapsedProjectKeys: ReadonlySet<string>;
	rows: SidebarVirtualRow[];
	visibleOrders: SidebarChatOrderMap;
	visibleChatIds: string[];
	reorderScopesByChatId: Map<string, string[]>;
}): void {
	const scopeIds = input.orderedChatIds.filter((chatId) => {
		const chat = input.byId.get(chatId);
		return Boolean(chat) && input.placementByChatId.get(chatId) === input.section;
	});
	if (scopeIds.length === 0) return;

	const key = sidebarSectionKey(input.section);
	input.rows.push({
		type: 'section-header',
		key,
		section: input.section,
		count: scopeIds.length,
		chatIds: scopeIds,
		isCollapsed: input.collapsedProjectKeys.has(key),
	});
	if (input.collapsedProjectKeys.has(key)) return;

	for (const chatId of scopeIds) {
		const chat = input.byId.get(chatId);
		if (!chat) continue;
		appendChatRow(
			input.rows,
			createChatRow(
				chat,
				input.list,
				`${input.list}:section:${input.section}`,
				scopeIds,
				exactProjectGroup(chat.projectPath),
				true,
			),
			input.visibleOrders,
			input.visibleChatIds,
			input.reorderScopesByChatId,
		);
	}
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
	grouping: SidebarChatGrouping;
	currentTime: Date;
	groupNestedProjectPaths?: boolean;
	collapsedProjectKeys?: ReadonlySet<string>;
}): string[] {
	const orders = buildSidebarChatOrderMap(input.displayedChats);
	return buildSidebarRowModel({
		displayedChats: input.displayedChats,
		orders,
		grouping: input.grouping,
		currentTime: input.currentTime,
		groupNestedProjectPaths: input.groupNestedProjectPaths,
		collapsedProjectKeys: input.collapsedProjectKeys,
	}).visibleChatIds;
}
