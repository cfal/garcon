import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ScheduledPromptField from '../ScheduledPromptField.svelte';

function renderField(
	overrides: Partial<{
		prompt: string;
		promptError: string | null;
		targetType: 'new-chat' | 'existing-chat';
		surface: 'composer' | 'standalone';
	}> = {},
) {
	const onPromptChange = vi.fn();
	const onPromptKeydown = vi.fn();
	const result = render(ScheduledPromptField, {
		prompt: overrides.prompt ?? 'Review this section',
		promptError: overrides.promptError ?? null,
		targetType: overrides.targetType ?? 'new-chat',
		surface: overrides.surface ?? 'standalone',
		onPromptChange,
		onPromptKeydown,
	});
	return { ...result, onPromptChange, onPromptKeydown };
}

describe('ScheduledPromptField', () => {
	it('inserts the chat ID token at the selection and restores the caret and focus', async () => {
		const { onPromptChange } = renderField({ prompt: 'Review this section' });
		const textarea = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
		textarea.focus();
		textarea.setSelectionRange(7, 11);

		await fireEvent.click(screen.getByRole('button', { name: 'Insert {{chat_id}}' }));

		expect(onPromptChange).toHaveBeenCalledWith('Review {{chat_id}} section');
		expect(textarea.value).toBe('Review {{chat_id}} section');
		expect(document.activeElement).toBe(textarea);
		expect(textarea.selectionStart).toBe('Review {{chat_id}}'.length);
		expect(textarea.selectionEnd).toBe('Review {{chat_id}}'.length);
	});

	it('describes the selected target and keeps touch text at 16px on both surfaces', () => {
		const { rerender } = renderField({ targetType: 'new-chat', surface: 'composer' });
		let textarea = screen.getByRole('textbox', { name: 'Prompt' });

		expect(
			screen.getByText('Use {{chat_id}} for the chat this task creates each run.'),
		).toBeTruthy();
		expect(textarea.className).toContain('text-base');
		expect(textarea.className).toContain('sm:pointer-fine:text-sm');
		expect(textarea.className).not.toContain('sm:text-sm');

		rerender({
			prompt: 'Review this section',
			promptError: null,
			targetType: 'existing-chat',
			surface: 'standalone',
			onPromptChange: vi.fn(),
			onPromptKeydown: vi.fn(),
		});
		textarea = screen.getByRole('textbox', { name: 'Prompt' });
		expect(screen.getByText('Use {{chat_id}} for the selected chat.')).toBeTruthy();
		expect(textarea.className).toContain('text-base');
		expect(textarea.className).toContain('sm:pointer-fine:text-sm');
	});

	it('forwards the keyboard save gesture and associates validation feedback', async () => {
		const { onPromptKeydown } = renderField({
			prompt: '{{chat_id}}',
			promptError: 'The prompt is too long after chat IDs are inserted.',
		});
		const textarea = screen.getByRole('textbox', { name: 'Prompt' });

		expect(textarea.getAttribute('aria-invalid')).toBe('true');
		expect(textarea.getAttribute('aria-describedby')).toContain(
			screen.getByText('The prompt is too long after chat IDs are inserted.').id,
		);
		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(onPromptKeydown).toHaveBeenCalledOnce();
	});
});
