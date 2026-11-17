import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { SidebarInactivityDuration, SidebarSortMode } from '$lib/stores/local-settings.svelte';
import type { PinnedInsertPosition } from '$shared/settings';
import { chatOrderGroupFor } from '$shared/chat-filter-query';
import { PERSISTED_CHAT_ORDER_GROUPS } from '$shared/chat-order-contracts';
import { effectiveExecutorId } from '$shared/executors';
import { normalizeProjectPath } from '$lib/utils/project-path';
import { splitProjectPath } from '$lib/project-paths/compact-project-path';
import { isSidebarChatInactive } from './chat-inactivity';
import { buildSidebarDelegationForest } from './sidebar-delegation';
import {
	enabledSidebarGroupingFields,
	type SidebarGroupingSelection,
	type SidebarGroupingField,
} from './sidebar-preferences';
import type {
	SidebarChatOrderMap,
	SidebarChatSection,
	SidebarRowModel,
	SidebarVirtualRow,
	SidebarVirtualChatRow,
	SidebarTreeGuide,
	SidebarTreeScope,
} from './sidebar-virtual-chat-list';

const sections: SidebarChatSection[] = [
	'active',
	'inactive',
	'archived',
	'in-progress',
	'ready-for-review',
	'caught-up',
];

export interface SidebarRowModelInput {
	allChats: readonly ChatSessionRecord[];
	matchingChatIds?: ReadonlySet<string>;
	orders: SidebarChatOrderMap;
	groupingFields: readonly SidebarGroupingSelection[];
	nestDelegatedChats: boolean;
	separateArchivedBranches?: boolean;
	currentTime: Date;
	inactivityDuration: SidebarInactivityDuration;
	sortMode: SidebarSortMode;
	pinnedInsertPosition: PinnedInsertPosition;
	groupNestedProjectPaths?: boolean;
	collapsedProjectKeys?: ReadonlySet<string>;
	executorOrder?: readonly string[];
	isChatOptimisticallyArchived?: (chatId: string) => boolean;
}

export function buildSidebarChatOrderMap(chats: readonly ChatSessionRecord[]): SidebarChatOrderMap {
	const orders: SidebarChatOrderMap = { pinned: [], normal: [], archived: [] };
	for (const chat of chats) orders[chatOrderGroupFor(chat)].push(chat.id);
	return orders;
}

export function sidebarActivitySection(
	chat: Pick<
		ChatSessionRecord,
		'id' | 'status' | 'isPinned' | 'isArchived' | 'lastActivityAt' | 'createdAt'
	>,
	now: Date,
	duration: SidebarInactivityDuration,
): SidebarChatSection {
	if (chat.isPinned) return 'active';
	if (chat.isArchived) return 'archived';
	if (chat.status === 'draft') return 'active';
	return isSidebarChatInactive(chat, now, duration) ? 'inactive' : 'active';
}

export function sidebarStatusSection(
	chat: Pick<ChatSessionRecord, 'isProcessing' | 'isUnread'>,
): SidebarChatSection {
	if (chat.isProcessing) return 'in-progress';
	if (chat.isUnread) return 'ready-for-review';
	return 'caught-up';
}

export function sidebarProjectKey(path: string, executorId?: string | null): string {
	return JSON.stringify([effectiveExecutorId(executorId), normalizeProjectPath(path)]);
}

function projectGroups(chats: readonly ChatSessionRecord[], combine: boolean): Map<string, string> {
	const known = new Map<string, string>();
	for (const chat of chats) {
		const key = sidebarProjectKey(chat.projectPath, chat.executorId);
		const previous = known.get(key);
		if (previous === undefined || chat.projectPath < previous) known.set(key, chat.projectPath);
	}
	const groups = new Map<string, string>();
	for (const chat of chats) {
		const key = sidebarProjectKey(normalizeProjectPath(chat.projectPath), chat.executorId);
		if (groups.has(key)) continue;
		let path = normalizeProjectPath(chat.projectPath);
		let group = known.get(key)!;
		while (combine && path) {
			group = known.get(sidebarProjectKey(path, chat.executorId)) ?? group;
			const separator = path.lastIndexOf('/');
			if (separator < 0 || path === '/') break;
			path = separator === 0 ? '/' : path.slice(0, separator);
		}
		groups.set(key, group);
	}
	return groups;
}

export type SidebarGroupPath = readonly (readonly [SidebarGroupingField, string])[];

export function sidebarGroupCollapseKey(parentId: string | null, path: SidebarGroupPath): string {
	return `group:${JSON.stringify([parentId, path])}`;
}

interface ScopeTask {
	kind: 'scope';
	parentId: string | null;
	ids: string[];
	depth: number;
	tree?: SidebarTreeScope;
	path: SidebarGroupPath;
	inheritedFields: readonly SidebarGroupingField[];
	executorGrouped: boolean;
}

type ProjectionTask =
	| ScopeTask
	| { kind: 'header'; row: Exclude<SidebarVirtualRow, SidebarVirtualChatRow> }
	| { kind: 'chat'; row: SidebarVirtualChatRow };

function childTreeScope(
	parentDepth: number,
	delegationDepth: number,
	parent?: SidebarTreeGuide,
): SidebarTreeScope {
	let continuations = parent?.continuations ?? null;
	// Shared tails keep deep projections linear; terminal ancestors need no rail.
	if (parent && !parent.isLastChild) {
		continuations = { depth: parent.parentDepth, outer: continuations };
	}
	return { parentDepth, delegationDepth, continuations };
}

export function buildSidebarRowModel(input: SidebarRowModelInput): SidebarRowModel {
	const byId = new Map(input.allChats.map((chat) => [chat.id, chat]));
	const forest = buildSidebarDelegationForest(input.allChats, input);
	const matches = input.matchingChatIds ?? new Set(byId.keys());
	const filtered = input.matchingChatIds !== undefined;
	const matchCounts = new Map<string, number>();
	for (let index = forest.preorder.length - 1; index >= 0; index--) {
		const id = forest.preorder[index];
		const count = (matchCounts.get(id) ?? 0) + Number(matches.has(id));
		matchCounts.set(id, count);
		const parent = forest.branches.get(id)!.parentId;
		if (parent !== null) matchCounts.set(parent, (matchCounts.get(parent) ?? 0) + count);
	}
	const hasMatches = (id: string) => (matchCounts.get(id) ?? 0) > 0;
	const fields = enabledSidebarGroupingFields(input.groupingFields);
	const projects = projectGroups(input.allChats, Boolean(input.groupNestedProjectPaths));
	const projectFor = (chat: ChatSessionRecord) =>
		projects.get(sidebarProjectKey(normalizeProjectPath(chat.projectPath), chat.executorId)) ??
		chat.projectPath;
	const rank = new Map(
		PERSISTED_CHAT_ORDER_GROUPS.flatMap((band) =>
			input.orders[band].map((id, index) => [id, index] as const),
		),
	);
	const executorRanks = new Map((input.executorOrder ?? []).map((id, index) => [id, index]));
	const model: SidebarRowModel = {
		rows: [],
		visibleChatIds: [],
		matchingChatIds: [...matches].filter((id) => byId.has(id)),
		actionableChatIds: [],
	};
	const valueFor = (field: SidebarGroupingField, chat: ChatSessionRecord): string => {
		switch (field) {
			case 'executor':
				return effectiveExecutorId(chat.executorId);
			case 'project':
				return sidebarProjectKey(projectFor(chat), chat.executorId);
			case 'activity':
				return sidebarActivitySection(chat, input.currentTime, input.inactivityDuration);
			case 'status':
				return sidebarStatusSection(chat);
		}
	};
	const compareGroups = (field: SidebarGroupingField, a: string, b: string): number => {
		if (field === 'executor') {
			if (a === 'local') return -1;
			if (b === 'local') return 1;
			return (
				(executorRanks.get(a) ?? Infinity) - (executorRanks.get(b) ?? Infinity) ||
				a.localeCompare(b)
			);
		}
		if (field === 'activity' || field === 'status')
			return sections.indexOf(a as SidebarChatSection) - sections.indexOf(b as SidebarChatSection);
		const [executorA, pathA] = JSON.parse(a) as [string, string];
		const [executorB, pathB] = JSON.parse(b) as [string, string];
		return (
			(pathA || 'Unknown project').localeCompare(pathB || 'Unknown project') ||
			executorA.localeCompare(executorB)
		);
	};
	const compareChats = (a: string, b: string): number => {
		const left = byId.get(a)!;
		const right = byId.get(b)!;
		const band = chatOrderGroupFor(left);
		const bandDifference =
			PERSISTED_CHAT_ORDER_GROUPS.indexOf(band) -
			PERSISTED_CHAT_ORDER_GROUPS.indexOf(chatOrderGroupFor(right));
		if (bandDifference) return bandDifference;
		if (band === 'archived') {
			const rightOptimistic = input.isChatOptimisticallyArchived?.(b) ?? false;
			const leftOptimistic = input.isChatOptimisticallyArchived?.(a) ?? false;
			const archiveDifference = Number(rightOptimistic) - Number(leftOptimistic);
			if (archiveDifference) return archiveDifference;
			if (leftOptimistic) return (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity);
		}
		if (input.sortMode === 'recent') {
			const difference =
				Number(right.status === 'draft') - Number(left.status === 'draft') ||
				forest.branches.get(b)!.activity - forest.branches.get(a)!.activity;
			if (difference)
				return band === 'pinned' && input.pinnedInsertPosition === 'bottom'
					? -difference
					: difference;
		}
		return (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a.localeCompare(b);
	};
	const tasks: ProjectionTask[] = [
		{
			kind: 'scope',
			parentId: null,
			ids: forest.roots.filter(hasMatches),
			depth: 0,
			path: [],
			inheritedFields: [],
			executorGrouped: false,
		},
	];
	while (tasks.length) {
		const task = tasks.pop()!;
		if (task.kind === 'header') {
			model.rows.push(task.row);
			continue;
		}
		if (task.kind === 'chat') {
			const row = task.row;
			model.rows.push(row);
			model.visibleChatIds.push(row.chat.id);
			if (!row.contextOnly) model.actionableChatIds.push(row.chat.id);
			const children = forest.branches.get(row.chat.id)!.children;
			if (children.length && !row.branch?.isCollapsed) {
				// Full-roster siblings keep inherited headers stable while searching.
				const inheritedFields = fields.filter((field) => {
					const value = valueFor(field, row.chat);
					return children.every((id) => valueFor(field, byId.get(id)!) === value);
				});
				tasks.push({
					kind: 'scope',
					parentId: row.chat.id,
					ids: children.filter(hasMatches),
					depth: row.depth + 1,
					tree: childTreeScope(row.depth, (row.tree?.delegationDepth ?? 0) + 1, row.tree),
					path: [],
					inheritedFields,
					executorGrouped: false,
				});
			}
			continue;
		}
		if (!task.ids.length) continue;
		const field = fields[task.path.length];
		if (field !== undefined) {
			if (task.inheritedFields.includes(field)) {
				// Retains structural scope keys without an invisible collapse gate or extra indent.
				tasks.push({
					...task,
					path: [...task.path, [field, valueFor(field, byId.get(task.ids[0])!)]],
					executorGrouped: task.executorGrouped || field === 'executor',
				});
				continue;
			}
			const partitions = new Map<string, string[]>();
			for (const id of task.ids) {
				const value = valueFor(field, byId.get(id)!);
				const ids = partitions.get(value) ?? [];
				ids.push(id);
				partitions.set(value, ids);
			}
			const values = [...partitions.keys()].sort((a, b) => compareGroups(field, a, b));
			for (let index = values.length - 1; index >= 0; index--) {
				const value = values[index];
				const ids = partitions.get(value)!;
				const path = [...task.path, [field, value] as const];
				const key = sidebarGroupCollapseKey(task.parentId, path);
				const isCollapsed = !filtered && Boolean(input.collapsedProjectKeys?.has(key));
				const ranges = ids.map((id) => forest.branches.get(id)!).sort((a, b) => a.start - b.start);
				const containsChat = (id: string): boolean => {
					const target = forest.branches.get(id);
					if (!target) return false;
					let low = 0;
					let high = ranges.length;
					while (low < high) {
						const mid = (low + high) >>> 1;
						if (ranges[mid].start <= target.start) low = mid + 1;
						else high = mid;
					}
					return low > 0 && target.start < ranges[low - 1].end;
				};
				const common = {
					key,
					depth: task.depth,
					tree: task.tree ? { ...task.tree, isLastChild: index === values.length - 1 } : undefined,
					count: ids.reduce((sum, id) => sum + (matchCounts.get(id) ?? 0), 0),
					containsChat,
					isCollapsed,
				};
				let row: Exclude<SidebarVirtualRow, SidebarVirtualChatRow>;
				if (field === 'executor')
					row = { ...common, type: 'executor-header', executorId: value, collapseKey: key };
				else if (field === 'project') {
					const chat = byId.get(ids[0])!;
					row = {
						...common,
						type: 'project-header',
						projectKey: value,
						projectPath: projectFor(chat),
						executorId: effectiveExecutorId(chat.executorId),
						executorGrouped: task.executorGrouped,
						collapseKey: key,
					};
				} else row = { ...common, type: 'section-header', section: value as SidebarChatSection };
				if (!isCollapsed)
					tasks.push({
						...task,
						ids,
						path,
						depth: task.depth + 1,
						// Root grouping headers do not start delegated tree guides.
						tree: row.tree
							? childTreeScope(row.depth, row.tree.delegationDepth, row.tree)
							: undefined,
						executorGrouped: task.executorGrouped || field === 'executor',
					});
				tasks.push({ kind: 'header', row });
			}
			continue;
		}
		const ordered = [...task.ids].sort(compareChats);
		const scopes = buildSidebarChatOrderMap(
			ordered
				.filter((id) => matches.has(id) && !forest.ambiguousIds.has(id))
				.map((id) => byId.get(id)!),
		);
		for (let index = ordered.length - 1; index >= 0; index--) {
			const id = ordered[index];
			const chat = byId.get(id)!;
			const branch = forest.branches.get(id)!;
			const list = chatOrderGroupFor(chat);
			const collapseKey = `delegation:${id}`;
			const contextOnly = !matches.has(id);
			const row: SidebarVirtualChatRow = {
				type: 'chat',
				key: `chat:${id}`,
				depth: task.depth,
				tree: task.tree ? { ...task.tree, isLastChild: index === ordered.length - 1 } : undefined,
				chat,
				list,
				isPinned: list === 'pinned',
				isArchived: list === 'archived',
				executorGrouped: task.executorGrouped,
				reorderScopeKey: JSON.stringify([
					input.nestDelegatedChats,
					input.nestDelegatedChats && Boolean(input.separateArchivedBranches),
					task.parentId,
					list,
					task.path,
				]),
				reorderScopeIds: contextOnly || forest.ambiguousIds.has(id) ? [] : scopes[list],
				contextOnly,
				section: task.path.find(([field]) => field === 'activity')?.[1] as
					SidebarChatSection | undefined,
				branch: branch.descendants
					? {
							collapseKey,
							isCollapsed: !filtered && Boolean(input.collapsedProjectKeys?.has(collapseKey)),
							descendants: branch.descendants,
							unread: branch.unread - Number(chat.isUnread),
							processing: branch.processing - Number(chat.isProcessing),
							activity: branch.activity,
							containsChat: (target) => forest.contains(id, target),
						}
					: undefined,
			};
			tasks.push({ kind: 'chat', row });
		}
	}
	const pathsByName = new Map<string, Set<string>>();
	const projectNameKey = (row: Extract<SidebarVirtualRow, { type: 'project-header' }>) =>
		JSON.stringify([effectiveExecutorId(row.executorId), splitProjectPath(row.projectPath).name]);
	for (const row of model.rows) {
		if (row.type !== 'project-header') continue;
		const name = projectNameKey(row);
		const paths = pathsByName.get(name) ?? new Set();
		paths.add(normalizeProjectPath(row.projectPath));
		pathsByName.set(name, paths);
	}
	for (const row of model.rows)
		if (row.type === 'project-header')
			row.showParentPath = pathsByName.get(projectNameKey(row))!.size > 1;
	return model;
}

export interface SidebarChatListProjection {
	rowModel: SidebarRowModel;
}

export function buildSidebarChatListProjection(
	input: Omit<SidebarRowModelInput, 'orders'> & { orders?: SidebarChatOrderMap },
): SidebarChatListProjection {
	return {
		rowModel: buildSidebarRowModel({
			...input,
			orders: input.orders ?? buildSidebarChatOrderMap(input.allChats),
		}),
	};
}
