import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
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
	it('does not insert into a draft that changed while the variable menu was open', async () => {
		const { rerender, onPromptChange, onPromptKeydown } = renderField();
		await fireEvent.click(screen.getByRole('button', { name: 'Insert variable' }));
		await rerender({ prompt: 'A newer draft', promptError: null, targetType: 'new-chat', surface: 'standalone', onPromptChange, onPromptKeydown });
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Current date \(UTC\)/ }));
		expect(onPromptChange).not.toHaveBeenCalled();
		expect((screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('A newer draft');
	});
	it.each(['chat_id', 'current_date', 'current_date_local'])('inserts %s at the selection and restores the caret and focus', async (variable) => {
		const { onPromptChange } = renderField({ prompt: 'Review this section' });
		const textarea = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
		textarea.focus();
		textarea.setSelectionRange(7, 11);

		await fireEvent.click(screen.getByRole('button', { name: 'Insert variable' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(`\\{\\{${variable}\\}\\}`) }));

		expect(onPromptChange).toHaveBeenCalledWith(`Review {{${variable}}} section`);
		expect(textarea.value).toBe(`Review {{${variable}}} section`);
		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect(textarea.selectionStart).toBe(`Review {{${variable}}}`.length);
		expect(textarea.selectionEnd).toBe(`Review {{${variable}}}`.length);
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
