import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatParentRelation, ParentChatRef } from '$shared/chat-parentage';
import { buildChatMapModel, type ChatMapChatNode, type ChatMapNode } from '../chat-map-model';

function parent(chatId: string, relation: ChatParentRelation = 'fork'): ParentChatRef {
	return relation === 'delegation'
		? { chatId, relation }
		: { chatId, relation, transcriptViewId: `view-${chatId}`, ordinal: 1 };
}

function chat(id: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id,
		parentChat: null,
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: `Chat ${id}`,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2026-08-01T00:00:00.000Z',
		lastActivityAt: '2026-08-01T00:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		canReloadFromNativeHistory: false,
		isUnread: false,
		status: 'running',
		agentOwnershipEpoch: null,
		tags: [],
		...overrides,
	};
}

function flatten(roots: readonly ChatMapNode[]): ChatMapNode[] {
	const result: ChatMapNode[] = [];
	const stack = [...roots].reverse();
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		result.push(node);
		for (let index = node.children.length - 1; index >= 0; index -= 1) {
			stack.push(node.children[index]);
		}
	}
	return result;
}

function chatNode(nodes: readonly ChatMapNode[], id: string): ChatMapChatNode {
	const node = nodes.find((candidate) => candidate.kind === 'chat' && candidate.chat.id === id);
	if (!node || node.kind !== 'chat') throw new Error(`Missing chat node ${id}`);
	return node;
}

describe('buildChatMapModel', () => {
	it('builds immediate-parent chains and retains incoming relations', () => {
		const model = buildChatMapModel([
			chat('root'),
			chat('fork', { parentChat: parent('root', 'fork') }),
			chat('handoff', { parentChat: parent('fork', 'handoff') }),
			chat('delegation', { parentChat: parent('handoff', 'delegation') }),
		]);

		expect(model.roots).toHaveLength(1);
		expect(model.roots[0].key).toBe('chat:root');
		expect(model.roots[0].children[0].key).toBe('chat:fork');
		expect(model.roots[0].children[0].children[0].key).toBe('chat:handoff');
		expect(model.roots[0].children[0].children[0].children[0].key).toBe('chat:delegation');
		expect(chatNode(flatten(model.roots), 'root').relation).toBeNull();
		expect(chatNode(flatten(model.roots), 'fork').relation).toBe('fork');
		expect(chatNode(flatten(model.roots), 'handoff').relation).toBe('handoff');
		expect(chatNode(flatten(model.roots), 'delegation').relation).toBe('delegation');
	});

	it('orders siblings by creation time and ID, then roots by newest subtree activity', () => {
		const model = buildChatMapModel([
			chat('older-root', {
				createdAt: '2026-01-01T00:00:00.000Z',
				lastActivityAt: '2026-01-01T00:00:00.000Z',
			}),
			chat('later-b', {
				parentChat: parent('older-root'),
				createdAt: '2026-02-01T00:00:00.000Z',
				lastActivityAt: '2026-12-01T00:00:00.000Z',
			}),
			chat('later-a', {
				parentChat: parent('older-root'),
				createdAt: '2026-02-01T00:00:00.000Z',
			}),
			chat('newer-root', {
				createdAt: '2026-06-01T00:00:00.000Z',
				lastActivityAt: '2026-06-01T00:00:00.000Z',
			}),
		]);

		expect(model.roots.map((node) => node.key)).toEqual(['chat:older-root', 'chat:newer-root']);
		expect(model.roots[0].children.map((node) => node.key)).toEqual([
			'chat:later-a',
			'chat:later-b',
		]);
	});

	it('shares one missing-parent root across dangling children', () => {
		const model = buildChatMapModel([
			chat('child-b', { parentChat: parent('gone', 'handoff') }),
			chat('child-a', { parentChat: parent('gone', 'fork') }),
		]);

		expect(model.missingParentCount).toBe(1);
		expect(model.rootCount).toBe(1);
		expect(model.roots[0]).toMatchObject({ kind: 'missing-parent', chatId: 'gone' });
		expect(model.roots[0].children.map((node) => node.key)).toEqual([
			'chat:child-a',
			'chat:child-b',
		]);
		expect(chatNode(flatten(model.roots), 'child-b').relation).toBe('handoff');
	});

	it('replaces a removed parent with a missing-parent root without dropping its child', () => {
		const child = chat('child', { parentChat: parent('parent') });
		const withParent = buildChatMapModel([chat('parent'), child]);
		const withoutParent = buildChatMapModel([child]);

		expect(withParent.roots[0].key).toBe('chat:parent');
		expect(withoutParent.roots[0].key).toBe('missing:parent');
		expect(flatten(withoutParent.roots).map((node) => node.key)).toEqual([
			'missing:parent',
			'chat:child',
		]);
	});

	it('cuts a self-cycle and marks its chat', () => {
		const model = buildChatMapModel([chat('solo', { parentChat: parent('solo') })]);
		const node = chatNode(flatten(model.roots), 'solo');

		expect(model.cycleChatCount).toBe(1);
		expect(node).toMatchObject({ inCycle: true, cycleBreak: true, relation: null });
		expect(node.children).toHaveLength(0);
	});

	it('cuts the lexicographically smallest member of a multi-chat cycle', () => {
		const model = buildChatMapModel([
			chat('charlie', { parentChat: parent('bravo') }),
			chat('alpha', { parentChat: parent('charlie', 'handoff') }),
			chat('bravo', { parentChat: parent('alpha') }),
		]);
		const nodes = flatten(model.roots);

		expect(model.roots.map((node) => node.key)).toEqual(['chat:alpha']);
		expect(nodes.map((node) => node.key)).toEqual(['chat:alpha', 'chat:bravo', 'chat:charlie']);
		expect(model.cycleChatCount).toBe(3);
		expect(nodes.filter((node) => node.kind === 'chat' && node.inCycle)).toHaveLength(3);
		expect(chatNode(nodes, 'alpha')).toMatchObject({ cycleBreak: true, relation: null });
		expect(new Set(nodes.map((node) => node.key)).size).toBe(3);
	});

	it('excludes drafts and retains archived chats', () => {
		const model = buildChatMapModel([
			chat('draft', { status: 'draft' }),
			chat('archived', { isArchived: true }),
		]);

		expect(model.chatCount).toBe(1);
		expect(flatten(model.roots).map((node) => node.key)).toEqual(['chat:archived']);
	});

	it.each([
		['chat ID', 'target-id', chat('target-id')],
		['title', 'needle title', chat('target', { title: 'Needle title' })],
		['project path', 'special/project', chat('target', { projectPath: '/special/project' })],
		['agent ID', 'claude', chat('target', { agentId: 'claude' })],
		['model', 'opus-needle', chat('target', { model: 'opus-needle' })],
		['tag', 'urgent-needle', chat('target', { tags: ['urgent-needle'] })],
	])('matches query by %s', (_field, query, target) => {
		const model = buildChatMapModel([target, chat('unrelated', { agentId: 'codex' })], query);

		expect(model.matchCount).toBe(1);
		expect(flatten(model.roots).map((node) => node.key)).toEqual([`chat:${target.id}`]);
		expect(chatNode(flatten(model.roots), target.id).matchesQuery).toBe(true);
	});

	it('retains effective ancestors but omits unrelated descendants during search', () => {
		const model = buildChatMapModel(
			[
				chat('root'),
				chat('context', { parentChat: parent('root') }),
				chat('match', { parentChat: parent('context'), title: 'Find me' }),
				chat('unrelated', { parentChat: parent('root') }),
			],
			'find me',
		);
		const nodes = flatten(model.roots);

		expect(nodes.map((node) => node.key)).toEqual(['chat:root', 'chat:context', 'chat:match']);
		expect(chatNode(nodes, 'root').matchesQuery).toBe(false);
		expect(chatNode(nodes, 'match').matchesQuery).toBe(true);
		expect(model.allNodeKeys).toContain('chat:unrelated');
		expect(model.collapsibleNodeKeys).toEqual(['chat:root', 'chat:context']);
	});

	it('returns stable empty and zero-result models', () => {
		const empty = buildChatMapModel([]);
		const zeroResults = buildChatMapModel([chat('chat')], 'absent');

		expect(empty).toMatchObject({ roots: [], chatCount: 0, rootCount: 0, matchCount: 0 });
		expect(zeroResults.roots).toEqual([]);
		expect(zeroResults).toMatchObject({ chatCount: 1, rootCount: 1, matchCount: 0 });
		expect(zeroResults.allNodeKeys).toEqual(new Set(['chat:chat']));
	});

	it('normalizes several hundred nodes without recursion or loss', () => {
		const sessions: ChatSessionRecord[] = [];
		for (let index = 0; index < 600; index += 1) {
			const id = `chat-${String(index).padStart(4, '0')}`;
			sessions.push(
				chat(id, {
					parentChat: index === 0 ? null : parent(`chat-${String(index - 1).padStart(4, '0')}`),
				}),
			);
		}

		const model = buildChatMapModel(sessions);
		const keys = flatten(model.roots).map((node) => node.key);
		expect(keys).toHaveLength(600);
		expect(new Set(keys).size).toBe(600);
		expect(model.allNodeKeys.size).toBe(600);
	});
});
