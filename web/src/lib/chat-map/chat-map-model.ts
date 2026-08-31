import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatParentRelation } from '$shared/chat-parentage';

export type ChatMapNode = ChatMapChatNode | ChatMapMissingParentNode;

export interface ChatMapChatNode {
	readonly key: `chat:${string}`;
	readonly kind: 'chat';
	readonly chat: ChatSessionRecord;
	readonly relation: ChatParentRelation | null;
	readonly children: readonly ChatMapNode[];
	readonly matchesQuery: boolean;
	readonly inCycle: boolean;
	readonly cycleBreak: boolean;
}

export interface ChatMapMissingParentNode {
	readonly key: `missing:${string}`;
	readonly kind: 'missing-parent';
	readonly chatId: string;
	readonly children: readonly ChatMapNode[];
	readonly matchesQuery: boolean;
}

export interface ChatMapModel {
	readonly roots: readonly ChatMapNode[];
	readonly allNodeKeys: ReadonlySet<string>;
	readonly collapsibleNodeKeys: readonly string[];
	readonly chatCount: number;
	readonly rootCount: number;
	readonly missingParentCount: number;
	readonly cycleChatCount: number;
	readonly matchCount: number;
	readonly queryActive: boolean;
}

type ChatMapNodeKey = ChatMapNode['key'];

interface TopologyChatNode {
	readonly key: `chat:${string}`;
	readonly kind: 'chat';
	readonly chat: ChatSessionRecord;
	readonly relation: ChatParentRelation | null;
	readonly inCycle: boolean;
	readonly cycleBreak: boolean;
	readonly parentKey: ChatMapNodeKey | null;
	readonly childrenKeys: ChatMapNodeKey[];
}

interface TopologyMissingParentNode {
	readonly key: `missing:${string}`;
	readonly kind: 'missing-parent';
	readonly chatId: string;
	readonly parentKey: null;
	readonly childrenKeys: ChatMapNodeKey[];
}

type TopologyNode = TopologyChatNode | TopologyMissingParentNode;

function chatKey(chatId: string): `chat:${string}` {
	return `chat:${chatId}`;
}

function missingParentKey(chatId: string): `missing:${string}` {
	return `missing:${chatId}`;
}

function timestamp(value: string | null): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function chatActivity(chat: ChatSessionRecord): number {
	return Math.max(timestamp(chat.createdAt), timestamp(chat.lastActivityAt));
}

function findCycles(parentById: ReadonlyMap<string, string>): readonly string[][] {
	const settled = new Set<string>();
	const cycles: string[][] = [];

	for (const start of parentById.keys()) {
		if (settled.has(start)) continue;
		const path: string[] = [];
		const pathIndex = new Map<string, number>();
		let cursor: string | undefined = start;

		while (cursor && !settled.has(cursor)) {
			const cycleStart = pathIndex.get(cursor);
			if (cycleStart !== undefined) {
				cycles.push(path.slice(cycleStart));
				break;
			}
			pathIndex.set(cursor, path.length);
			path.push(cursor);
			cursor = parentById.get(cursor);
		}

		for (const chatId of path) settled.add(chatId);
	}

	return cycles;
}

function compareSiblingKeys(
	leftKey: ChatMapNodeKey,
	rightKey: ChatMapNodeKey,
	topologyByKey: ReadonlyMap<ChatMapNodeKey, TopologyNode>,
): number {
	const left = topologyByKey.get(leftKey);
	const right = topologyByKey.get(rightKey);
	if (left?.kind === 'chat' && right?.kind === 'chat') {
		const createdDifference = timestamp(left.chat.createdAt) - timestamp(right.chat.createdAt);
		if (createdDifference !== 0) return createdDifference;
	}
	return leftKey.localeCompare(rightKey);
}

function subtreeActivityByKey(
	rootKeys: readonly ChatMapNodeKey[],
	topologyByKey: ReadonlyMap<ChatMapNodeKey, TopologyNode>,
): ReadonlyMap<ChatMapNodeKey, number> {
	const activityByKey = new Map<ChatMapNodeKey, number>();
	const stack: Array<{ key: ChatMapNodeKey; visited: boolean }> = [];
	for (let index = rootKeys.length - 1; index >= 0; index -= 1) {
		stack.push({ key: rootKeys[index], visited: false });
	}

	while (stack.length > 0) {
		const entry = stack.pop();
		if (!entry) continue;
		const node = topologyByKey.get(entry.key);
		if (!node) continue;
		if (!entry.visited) {
			stack.push({ key: entry.key, visited: true });
			for (let index = node.childrenKeys.length - 1; index >= 0; index -= 1) {
				stack.push({ key: node.childrenKeys[index], visited: false });
			}
			continue;
		}

		let activity = node.kind === 'chat' ? chatActivity(node.chat) : 0;
		for (const childKey of node.childrenKeys) {
			activity = Math.max(activity, activityByKey.get(childKey) ?? 0);
		}
		activityByKey.set(entry.key, activity);
	}

	return activityByKey;
}

function orderedTopologyKeys(
	rootKeys: readonly ChatMapNodeKey[],
	topologyByKey: ReadonlyMap<ChatMapNodeKey, TopologyNode>,
): ChatMapNodeKey[] {
	const ordered: ChatMapNodeKey[] = [];
	const stack = [...rootKeys].reverse();
	while (stack.length > 0) {
		const key = stack.pop();
		if (!key) continue;
		ordered.push(key);
		const children = topologyByKey.get(key)?.childrenKeys ?? [];
		for (let index = children.length - 1; index >= 0; index -= 1) {
			stack.push(children[index]);
		}
	}
	return ordered;
}

function matchesChat(chat: ChatSessionRecord, query: string): boolean {
	return [chat.id, chat.title, chat.projectPath, chat.agentId, chat.model ?? '', ...chat.tags]
		.join('\n')
		.toLowerCase()
		.includes(query);
}

export function buildChatMapModel(
	sessions: readonly ChatSessionRecord[],
	query = '',
): ChatMapModel {
	const chatsById = new Map<string, ChatSessionRecord>();
	for (const session of sessions) {
		if (session.status !== 'draft') chatsById.set(session.id, session);
	}

	const parentById = new Map<string, string>();
	for (const chat of chatsById.values()) {
		const parentId = chat.parentChat?.chatId;
		if (parentId && chatsById.has(parentId)) parentById.set(chat.id, parentId);
	}

	const cycleChatIds = new Set<string>();
	const cycleRootIds = new Set<string>();
	for (const cycle of findCycles(parentById)) {
		for (const chatId of cycle) cycleChatIds.add(chatId);
		cycleRootIds.add([...cycle].sort((left, right) => left.localeCompare(right))[0]);
	}

	const topologyByKey = new Map<ChatMapNodeKey, TopologyNode>();
	for (const chat of chatsById.values()) {
		const cycleBreak = cycleRootIds.has(chat.id);
		const parentChat = chat.parentChat;
		let parentKey: ChatMapNodeKey | null = null;
		let relation: ChatParentRelation | null = null;
		if (!cycleBreak && parentChat) {
			parentKey = chatsById.has(parentChat.chatId)
				? chatKey(parentChat.chatId)
				: missingParentKey(parentChat.chatId);
			relation = parentChat.relation;
		}
		const key = chatKey(chat.id);
		topologyByKey.set(key, {
			key,
			kind: 'chat',
			chat,
			relation,
			inCycle: cycleChatIds.has(chat.id),
			cycleBreak,
			parentKey,
			childrenKeys: [],
		});
	}

	for (const chat of chatsById.values()) {
		const parentChat = chat.parentChat;
		if (!parentChat || chatsById.has(parentChat.chatId)) continue;
		const key = missingParentKey(parentChat.chatId);
		if (topologyByKey.has(key)) continue;
		topologyByKey.set(key, {
			key,
			kind: 'missing-parent',
			chatId: parentChat.chatId,
			parentKey: null,
			childrenKeys: [],
		});
	}

	const rootKeys: ChatMapNodeKey[] = [];
	for (const node of topologyByKey.values()) {
		if (node.parentKey) topologyByKey.get(node.parentKey)?.childrenKeys.push(node.key);
		else rootKeys.push(node.key);
	}
	for (const node of topologyByKey.values()) {
		node.childrenKeys.sort((left, right) => compareSiblingKeys(left, right, topologyByKey));
	}
	const activityByKey = subtreeActivityByKey(rootKeys, topologyByKey);
	rootKeys.sort((left, right) => {
		const activityDifference = (activityByKey.get(right) ?? 0) - (activityByKey.get(left) ?? 0);
		return activityDifference || left.localeCompare(right);
	});

	const allOrderedKeys = orderedTopologyKeys(rootKeys, topologyByKey);
	const allNodeKeys = new Set<string>(allOrderedKeys);
	const collapsibleNodeKeys = allOrderedKeys.filter(
		(key) => (topologyByKey.get(key)?.childrenKeys.length ?? 0) > 0,
	);
	const normalizedQuery = query.trim().toLowerCase();
	const queryActive = normalizedQuery.length > 0;
	const matchingChatIds = new Set<string>();
	for (const chat of chatsById.values()) {
		if (!queryActive || matchesChat(chat, normalizedQuery)) matchingChatIds.add(chat.id);
	}

	const includedKeys = new Set<ChatMapNodeKey>();
	if (!queryActive) {
		for (const key of allOrderedKeys) includedKeys.add(key);
	} else {
		for (const chatId of matchingChatIds) {
			let key: ChatMapNodeKey | null = chatKey(chatId);
			while (key && !includedKeys.has(key)) {
				includedKeys.add(key);
				key = topologyByKey.get(key)?.parentKey ?? null;
			}
		}
	}

	const renderedByKey = new Map<ChatMapNodeKey, ChatMapNode>();
	for (let index = allOrderedKeys.length - 1; index >= 0; index -= 1) {
		const key = allOrderedKeys[index];
		if (!includedKeys.has(key)) continue;
		const source = topologyByKey.get(key);
		if (!source) continue;
		const children: ChatMapNode[] = [];
		for (const childKey of source.childrenKeys) {
			const child = renderedByKey.get(childKey);
			if (child) children.push(child);
		}
		if (source.kind === 'chat') {
			renderedByKey.set(key, {
				key: source.key,
				kind: 'chat',
				chat: source.chat,
				relation: source.relation,
				children,
				matchesQuery: matchingChatIds.has(source.chat.id),
				inCycle: source.inCycle,
				cycleBreak: source.cycleBreak,
			});
		} else {
			renderedByKey.set(key, {
				key: source.key,
				kind: 'missing-parent',
				chatId: source.chatId,
				children,
				matchesQuery: false,
			});
		}
	}

	return {
		roots: rootKeys.flatMap((key) => {
			const root = renderedByKey.get(key);
			return root ? [root] : [];
		}),
		allNodeKeys,
		collapsibleNodeKeys,
		chatCount: chatsById.size,
		rootCount: rootKeys.length,
		missingParentCount: [...topologyByKey.values()].filter((node) => node.kind === 'missing-parent')
			.length,
		cycleChatCount: cycleChatIds.size,
		matchCount: matchingChatIds.size,
		queryActive,
	};
}
