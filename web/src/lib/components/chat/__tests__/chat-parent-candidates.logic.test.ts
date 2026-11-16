import { describe, expect, it } from 'vitest';
import {
	eligibleParentChats,
	matchParentChats,
	typedParentId,
	type ParentCandidate,
} from '../chat-parent-candidates';

function candidate(id: string, title = id, parentId?: string): ParentCandidate {
	return {
		id,
		title,
		status: 'running',
		parentChat: parentId ? { chatId: parentId, relation: 'delegation' } : null,
		lastActivityAt: null,
	};
}

describe('parent chat candidates', () => {
	it('excludes self, drafts and descendants through every relation kind, including cycles', () => {
		const chats = [
			candidate('a'),
			candidate('b', 'B', 'a'),
			candidate('c', 'C', 'b'),
			candidate('d'),
			candidate('draft'),
		];
		chats[1]!.parentChat = { chatId: 'a', relation: 'fork', transcriptViewId: 'view', ordinal: 0 };
		chats[0]!.parentChat = { chatId: 'c', relation: 'delegation' };
		chats[4]!.status = 'draft';
		expect(eligibleParentChats(chats, 'a').map((chat) => chat.id)).toEqual(['d']);
	});

	it('ranks exact ID before literal prefixes and title substrings, retaining duplicate titles', () => {
		const chats = [
			candidate('1234', 'Other'),
			candidate('123', 'Other'),
			candidate('1', 'X123'),
			candidate('2', '123'),
			candidate('3', '123'),
		];
		expect(matchParentChats(chats, '123').map((chat) => chat.id)).toEqual([
			'123',
			'3',
			'2',
			'1234',
			'1',
		]);
		expect(matchParentChats([candidate('1', 'Fix [ABC]')], '[abc]')).toHaveLength(1);
		expect(typedParentId('title')).toBeUndefined();
		expect(typedParentId('1783725900000200')).toBe('1783725900000200');
	});

	it('bounds results for a 12,000-chat roster and walks deep ancestry iteratively', () => {
		const chats = Array.from({ length: 12_000 }, (_, index) =>
			candidate(String(index), 'Chat', index ? String(index - 1) : undefined),
		);
		expect(matchParentChats(chats, '')).toHaveLength(20);
		expect(eligibleParentChats(chats, '0')).toEqual([]);
	});
});
