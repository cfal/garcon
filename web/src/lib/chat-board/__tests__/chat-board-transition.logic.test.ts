import { describe, expect, it } from 'vitest';
import type { ChatBoard } from '$shared/chat-boards';
import { initialTargetTags, projectChatBoardTransition } from '../transition/chat-board-transition';

const board: ChatBoard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Board',
	columns: [
		{
			id: '22222222-2222-4222-8222-222222222222',
			name: 'Ready',
			match: 'all',
			tags: ['project-x', 'ready'],
		},
		{
			id: '33333333-3333-4333-8333-333333333333',
			name: 'Review',
			match: 'any',
			tags: ['review', 'shared'],
		},
		{
			id: '44444444-4444-4444-8444-444444444444',
			name: 'Frontend',
			match: 'all',
			tags: ['frontend'],
		},
	],
};

describe('Chat Board transition projection', () => {
	it('starts ANY targets with only already-present tags selected', () => {
		expect(initialTargetTags(['project-x', 'ready', 'shared'], board.columns[1])).toEqual([
			'shared',
		]);
		expect(initialTargetTags(['project-x', 'ready'], board.columns[1])).toEqual([]);
	});

	it('shows net changes, retained memberships, and source departure', () => {
		const preview = projectChatBoardTransition({
			board,
			source: board.columns[0],
			target: board.columns[1],
			currentTags: ['frontend', 'project-x', 'ready', 'shared'],
			selectedTargetTags: ['review', 'shared'],
		});

		expect(preview.removedTags).toEqual(['project-x', 'ready']);
		expect(preview.addedTags).toEqual(['review']);
		expect(preview.resultingTags).toEqual(['frontend', 'review', 'shared']);
		expect(preview.matchingColumnIds).toEqual([board.columns[1].id, board.columns[2].id]);
		expect(preview.sourceStillMatches).toBe(false);
		expect(preview.isNoop).toBe(false);
	});
});
