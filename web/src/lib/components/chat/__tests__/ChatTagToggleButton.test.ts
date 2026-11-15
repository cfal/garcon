import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ChatTagToggleButton from '../ChatTagToggleButton.svelte';

describe('ChatTagToggleButton', () => {
	it('keeps the scheduled-chat tag control compact and icon-only', async () => {
		const onToggle = vi.fn();
		const view = render(ChatTagToggleButton, { active: false, onToggle });
		const button = screen.getByRole('button', { name: 'Add tags' });
		expect(button.textContent?.trim()).toBe('');
		expect(button.hasAttribute('aria-expanded')).toBe(false);

		await fireEvent.click(button);
		expect(onToggle).toHaveBeenCalledOnce();
		await view.rerender({ active: true });
		expect(screen.getByRole('button', { name: 'Add tags' })).toBe(button);
		expect(button.textContent?.trim()).toBe('');
	});
});
