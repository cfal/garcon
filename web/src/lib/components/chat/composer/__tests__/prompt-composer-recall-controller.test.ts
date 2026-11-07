import { describe, expect, it, vi } from 'vitest';
import { PromptComposerRecallController } from '../prompt-composer-recall-controller';
import type { PromptRecallSource } from '$lib/chat/composer/prompt-recall';

function fixture() {
	let text = '', revision = 0, identity = 'chat:view', visible = true;
	let complete!: (text: string) => void;
	const source: PromptRecallSource = {
		list: async () => [{ ordinal: 1, watermark: 1 }],
		load: () => new Promise(resolve => { complete = resolve; }),
	};
	const setText = vi.fn((next: string) => { text = next; revision++; });
	const onError = vi.fn();
	const controller = new PromptComposerRecallController({
		getIdentity: () => identity,
		getSource: () => source,
		getText: () => text,
		getDraftRevision: () => revision,
		getTextarea: () => undefined,
		canRecall: () => visible,
		setText,
		onError,
	});
	return {
		controller, setText, onError,
		edit(next: string) { text = next; revision++; },
		switchChat() { identity = 'other:view'; },
		hide() { visible = false; },
		finish() { complete('Synthetic recalled prompt'); },
	};
}

describe('composer async recall ownership', () => {
	it('does not overwrite an edited-then-cleared draft', async () => {
		const test = fixture();
		expect(test.controller.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe(true);
		await Promise.resolve();
		test.edit('New draft');
		test.edit('');
		test.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(test.setText).not.toHaveBeenCalled();
	});

	it.each(['switchChat', 'hide'] as const)('drops completion after %s', async transition => {
		const test = fixture();
		test.controller.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
		await Promise.resolve();
		test[transition]();
		test.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(test.setText).not.toHaveBeenCalled();
	});

	it('applies a selected prompt to its unchanged draft', async () => {
		const test = fixture();
		test.controller.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
		await Promise.resolve();
		test.finish();
		await vi.waitFor(() => expect(test.setText).toHaveBeenCalledWith('Synthetic recalled prompt'));
	});
});
