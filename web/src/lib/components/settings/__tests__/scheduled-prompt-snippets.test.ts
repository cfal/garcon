import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ScheduledPromptSnippets } from '../scheduled-prompt-snippets.svelte';
import { expandSnippet } from '$lib/api/snippets.js';
import { selectableSnippets } from '$lib/snippets/selectable-snippet.js';

vi.mock('$lib/api/snippets.js', () => ({ expandSnippet: vi.fn() }));
const expand = vi.mocked(expandSnippet);
const item = selectableSnippets(
	[
		{
			id: 'review',
			shortName: 'review',
			template: 'Review {{arguments}} {{chat_id}}',
			defaultArguments: 'API',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	],
	[],
)[0];
const response = {
	success: true as const,
	source: 'snippet' as const,
	sourceId: 'review',
	sourceUpdatedAt: item.updatedAt,
	shortName: 'review',
	contextProjectPath: '/repo',
	contextExecutorId: 'local',
	expandedText: 'Review API {{chat_id}}',
};

function fixture() {
	const input = { prompt: 'Before selected after', key: 'new-chat:/repo' };
	const onInsert = vi.fn(async (_text: string, _caret: number) => {});
	const onPendingChange = vi.fn();
	const controller = new ScheduledPromptSnippets({
		get prompt() {
			return input.prompt;
		},
		get interactionKey() {
			return input.key;
		},
		get context() {
			return {
				type: 'scheduled-prompt' as const,
				target: { type: 'new-chat' as const, projectPath: '/repo' },
			};
		},
		onInsert,
		onPendingChange,
	});
	return { input, controller, onInsert, onPendingChange };
}

beforeEach(() => {
	expand.mockReset();
	expand.mockResolvedValue(response);
});

describe('scheduled prompt snippets', () => {
	it('replaces the selection and supplies the caret while blocking save during expansion', async () => {
		const { controller, onInsert, onPendingChange } = fixture();
		controller.open(7, 15);
		expect(await controller.insert(item, 'API')).toBe('inserted');
		expect(expand.mock.calls[0][0]).toEqual({
			shortName: 'review',
			arguments: { type: 'value', value: 'API' },
			context: { type: 'scheduled-prompt', target: { type: 'new-chat', projectPath: '/repo' } },
		});
		expect(onInsert).toHaveBeenCalledWith(
			'Before Review API {{chat_id}} after',
			'Before Review API {{chat_id}}'.length,
		);
		expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
	});

	it('replaces the configured inline trigger while preserving surrounding prose', async () => {
		const { input, controller, onInsert } = fixture();
		input.prompt = 'Before ;;review after';
		controller.detectTrigger(15, ';;');
		expect(controller.palette.isOpen).toBe(true);
		expect(controller.palette.initialQuery).toBe('review');
		expect(await controller.insert(item, '')).toBe('inserted');
		expect(onInsert.mock.calls[0][0]).toBe('Before Review API {{chat_id}} after');
	});

	it('detects input before its parent prompt prop updates', async () => {
		const { input, controller, onInsert } = fixture();
		input.prompt = 'Before ; after';
		controller.detectTrigger(9, ';;', 'Before ;; after');
		expect(controller.palette.isOpen).toBe(true);
		expect(controller.palette.initialQuery).toBe('');
		input.prompt = 'Before ;; after';
		expect(await controller.insert(item, '')).toBe('inserted');
		expect(onInsert.mock.calls[0][0]).toBe('Before Review API {{chat_id}} after');
	});

	it.each(['edit', 'target', 'close'])('discards a delayed response after %s', async (change) => {
		const { input, controller, onInsert } = fixture();
		let resolve!: (value: typeof response) => void;
		expand.mockImplementation(() => new Promise((done) => (resolve = done)));
		controller.open(7, 15);
		const pending = controller.insert(item, 'API');
		if (change === 'edit') input.prompt = 'Edited';
		if (change === 'target') input.key = 'chat:other';
		if (change === 'close') controller.cancel();
		resolve(response);
		expect(await pending).toBe('cancelled');
		expect(onInsert).not.toHaveBeenCalled();
	});

	it('keeps text intact and exposes expansion failures and changed snippets', async () => {
		const { controller, onInsert } = fixture();
		expand.mockRejectedValueOnce(new Error('Path unavailable'));
		expect(await controller.insert(item, '')).toBe('failed');
		expect(controller.error).toBe('Path unavailable');
		expand.mockResolvedValueOnce({ ...response, sourceUpdatedAt: '2026-01-02T00:00:00.000Z' });
		expect(await controller.insert(item, '')).toBe('failed');
		expect(controller.error).toContain('changed');
		expect(onInsert).not.toHaveBeenCalled();
	});
});
