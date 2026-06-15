import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';

function nextAnimationFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

async function expectComposerFocus(textarea: HTMLElement): Promise<void> {
	await nextAnimationFrame();
	await waitFor(() => {
		expect(document.activeElement).toBe(textarea);
	});
}

describe('PromptComposer focus', () => {
	afterEach(() => {
		cleanup();
		document.querySelector('[data-testid="outside-focus"]')?.remove();
	});

	it('focuses the composer after disabled chat startup and on each next selected chat', async () => {
		const outsideButton = document.createElement('button');
		outsideButton.dataset.testid = 'outside-focus';
		outsideButton.textContent = 'Outside focus';
		document.body.append(outsideButton);

		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isLoading: false,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await expectComposerFocus(textarea);

		outsideButton.focus();
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-2',
			selectedStatus: 'draft',
			isLoading: true,
		});
		await nextAnimationFrame();

		expect(textarea.disabled).toBe(true);
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-2',
			selectedStatus: 'draft',
			isLoading: false,
		});
		await expectComposerFocus(textarea);

		for (const chatId of ['chat-3', 'chat-4', 'chat-5']) {
			outsideButton.focus();
			expect(document.activeElement).toBe(outsideButton);

			await rerender({
				selectedChatId: chatId,
				selectedStatus: 'running',
				isLoading: false,
			});
			await expectComposerFocus(textarea);
		}
	});

	it('retries app-shell focus requests after the selected chat becomes enabled', async () => {
		const outsideButton = document.createElement('button');
		outsideButton.dataset.testid = 'outside-focus';
		outsideButton.textContent = 'Outside focus';
		document.body.append(outsideButton);

		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'draft',
			isLoading: true,
			focusRequestToken: 0,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		outsideButton.focus();
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'draft',
			isLoading: true,
			focusRequestToken: 1,
		});
		await nextAnimationFrame();

		expect(textarea.disabled).toBe(true);
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'draft',
			isLoading: false,
			focusRequestToken: 1,
		});
		await expectComposerFocus(textarea);
	});
});
