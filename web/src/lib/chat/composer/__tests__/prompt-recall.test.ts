import { describe, expect, it } from 'vitest';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import { PromptRecallController, recentRecallPrompts } from '../prompt-recall';

const prompts = [
	{ ordinal: 3, content: 'latest' },
	{ ordinal: 1, content: 'earlier' },
];

describe('prompt recall', () => {
	it('takes at most 100 nonempty user prompts newest first', () => {
		const entries = Array.from({ length: 110 }, (_, ordinal) => ({
			ordinal,
			message: new UserMessage('synthetic-time', `Synthetic prompt ${ordinal}`),
		}));
		entries.push({ ordinal: 110, message: new UserMessage('synthetic-time', ' ') });
		const history = recentRecallPrompts([
			...entries,
			{ ordinal: 111, message: new AssistantMessage('synthetic-time', 'Synthetic answer') },
		]);
		expect(history).toHaveLength(100);
		expect(history[0]).toEqual({ ordinal: 109, content: 'Synthetic prompt 109' });
	});
	it('snapshots history while browsing and returns to an empty draft', () => {
		const recall = new PromptRecallController();
		expect(recall.navigate('ArrowDown', 'chat:view', '', prompts)).toBeNull();
		expect(recall.navigate('ArrowUp', 'chat:view', '', prompts)).toBe('latest');
		expect(recall.navigate('ArrowUp', 'chat:view', 'latest', [])).toBe('earlier');
		expect(recall.navigate('ArrowUp', 'chat:view', 'earlier', [])).toBe('earlier');
		expect(recall.navigate('ArrowDown', 'chat:view', 'earlier', [])).toBe('latest');
		expect(recall.navigate('ArrowDown', 'chat:view', 'latest', [])).toBe('');
	});
	it('preserves typed drafts, resets on transcript identity change, and has no cross-chat retention', () => {
		const recall = new PromptRecallController();
		expect(recall.navigate('ArrowUp', 'a:view', 'draft', prompts)).toBeNull();
		expect(recall.navigate('ArrowUp', 'a:view', '', prompts)).toBe('latest');
		expect(recall.navigate('ArrowUp', 'a:new-view', 'latest', prompts)).toBeNull();
		expect(recall.navigate('ArrowUp', 'b:view', '', [{ ordinal: 1, content: 'other' }])).toBe(
			'other',
		);
		recall.reset();
		expect(recall.navigate('ArrowUp', null, '', prompts)).toBeNull();
	});
});
