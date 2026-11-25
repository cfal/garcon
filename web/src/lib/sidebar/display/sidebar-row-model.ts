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
	DELEGATION_KEY_PREFIX,
	isSidebarKeyCollapsed,
	type SidebarCollapseChoices,
} from './sidebar-collapse';
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

export interface SidebarRowModelInput extends SidebarCollapseChoices {
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
	collapseDelegatedChatsByDefault?: boolean;
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

function projectKey(executorId: string, normalizedPath: string): string {
	return JSON.stringify([executorId, normalizedPath]);
}

export function sidebarProjectKey(path: string, executorId?: string | null): string {
	return projectKey(effectiveExecutorId(executorId), normalizeProjectPath(path));
}

interface SidebarProject {
	key: string;
	executorId: string;
	normalizedPath: string;
	displayPath: string;
}

function projectGroups(chats: readonly ChatSessionRecord[], combine: boolean) {
	const byKey = new Map<string, SidebarProject>();
	const byExecutor = new Map<string, Map<string, SidebarProject>>();
	for (const chat of chats) {
		const executorId = effectiveExecutorId(chat.executorId);
		let paths = byExecutor.get(executorId);
		if (!paths) byExecutor.set(executorId, (paths = new Map()));
		if (paths.has(chat.projectPath)) continue;
		const normalizedPath = normalizeProjectPath(chat.projectPath);
		const key = projectKey(executorId, normalizedPath);
		const project = { key, executorId, normalizedPath, displayPath: chat.projectPath };
		paths.set(chat.projectPath, project);
		const known = byKey.get(key);
		if (!known || project.displayPath < known.displayPath) byKey.set(key, project);
	}
	for (const [executorId, paths] of byExecutor) {
		const groups = new Map<string, SidebarProject | undefined>();
		for (const [rawPath, project] of paths) {
			// A trailing slash can expose whitespace: group the normalized spelling, retain the label.
			const key = projectKey(executorId, project.normalizedPath.trimEnd());
			if (!groups.has(key)) {
				let group = byKey.get(key);
				let path = project.normalizedPath;
				while (combine && path && path !== '/') {
					const separator = path.lastIndexOf('/');
					if (separator < 0) break;
					path = separator === 0 ? '/' : path.slice(0, separator);
					group = byKey.get(projectKey(executorId, path.trimEnd())) ?? group;
				}
				groups.set(key, group);
			}
			paths.set(rawPath, groups.get(key) ?? project);
		}
	}
	return {
		byKey,
		forChat(chat: ChatSessionRecord) {
			return byExecutor.get(effectiveExecutorId(chat.executorId))!.get(chat.projectPath)!;
		},
	};
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
	const matches = input.matchingChatIds;
	const filtered = matches !== undefined;
	const matchCounts = new Map<string, number>();
	if (matches) {
		for (let index = forest.preorder.length - 1; index >= 0; index--) {
			const id = forest.preorder[index];
			const count = (matchCounts.get(id) ?? 0) + Number(matches.has(id));
			matchCounts.set(id, count);
			const parent = forest.branches.get(id)!.parentId;
			if (parent !== null) matchCounts.set(parent, (matchCounts.get(parent) ?? 0) + count);
		}
	}
	const matchingBranches = (ids: string[]) =>
		filtered ? ids.filter((id) => (matchCounts.get(id) ?? 0) > 0) : ids;
	const branchCount = (id: string) =>
		filtered ? (matchCounts.get(id) ?? 0) : forest.branches.get(id)!.descendants + 1;
	const fields = enabledSidebarGroupingFields(input.groupingFields);
	const projects = fields.includes('project')
		? projectGroups(input.allChats, Boolean(input.groupNestedProjectPaths))
		: undefined;
	const rank = new Map(
		PERSISTED_CHAT_ORDER_GROUPS.flatMap((band) =>
			input.orders[band].map((id, index) => [id, index] as const),
		),
	);
	const executorRanks = new Map((input.executorOrder ?? []).map((id, index) => [id, index]));
	const model: SidebarRowModel = {
		rows: [],
		visibleChatIds: [],
		matchingChatIds: matches ? [...matches].filter((id) => byId.has(id)) : [...byId.keys()],
		actionableChatIds: [],
	};
	const valueFor = (field: SidebarGroupingField, chat: ChatSessionRecord): string => {
		switch (field) {
			case 'executor':
				return effectiveExecutorId(chat.executorId);
			case 'project':
				return projects!.forChat(chat).key;
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
		const left = projects!.byKey.get(a)!;
		const right = projects!.byKey.get(b)!;
		return (
			(left.normalizedPath || 'Unknown project').localeCompare(
				right.normalizedPath || 'Unknown project',
			) || left.executorId.localeCompare(right.executorId)
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
			ids: matchingBranches(forest.roots),
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
					ids: matchingBranches(children),
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
				let ranges: { start: number; end: number }[] | undefined;
				const containsChat = (id: string): boolean => {
					const target = forest.branches.get(id);
					if (!target) return false;
					ranges ??= ids.map((id) => forest.branches.get(id)!).sort((a, b) => a.start - b.start);
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
					count: ids.reduce((sum, id) => sum + branchCount(id), 0),
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
						projectPath: projects!.forChat(chat).displayPath,
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
				.filter((id) => (!matches || matches.has(id)) && !forest.ambiguousIds.has(id))
				.map((id) => byId.get(id)!),
		);
		const scopeKeys: Partial<Record<keyof SidebarChatOrderMap, string>> = {};
		const section = task.path.find(([field]) => field === 'activity')?.[1] as
			SidebarChatSection | undefined;
		for (let index = ordered.length - 1; index >= 0; index--) {
			const id = ordered[index];
			const chat = byId.get(id)!;
			const branch = forest.branches.get(id)!;
			const list = chatOrderGroupFor(chat);
			const collapseKey = DELEGATION_KEY_PREFIX + id;
			const contextOnly = matches !== undefined && !matches.has(id);
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
				reorderScopeKey: (scopeKeys[list] ??= JSON.stringify([
					input.nestDelegatedChats,
					input.nestDelegatedChats && Boolean(input.separateArchivedBranches),
					task.parentId,
					list,
					task.path,
				])),
				reorderScopeIds: contextOnly || forest.ambiguousIds.has(id) ? [] : scopes[list],
				contextOnly,
				section,
				branch: branch.descendants
					? {
							collapseKey,
							isCollapsed:
								!filtered &&
								isSidebarKeyCollapsed(collapseKey, input, input.collapseDelegatedChatsByDefault),
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
	const projectsByName = new Map<
		string,
		{
			paths: Set<string>;
			rows: Extract<SidebarVirtualRow, { type: 'project-header' }>[];
		}
	>();
	for (const row of model.rows) {
		if (row.type !== 'project-header') continue;
		const name = JSON.stringify([
			effectiveExecutorId(row.executorId),
			splitProjectPath(row.projectPath).name,
		]);
		let group = projectsByName.get(name);
		if (!group) projectsByName.set(name, (group = { paths: new Set(), rows: [] }));
		group.paths.add(row.projectKey);
		group.rows.push(row);
	}
	for (const { paths, rows } of projectsByName.values())
		for (const row of rows) row.showParentPath = paths.size > 1;
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
