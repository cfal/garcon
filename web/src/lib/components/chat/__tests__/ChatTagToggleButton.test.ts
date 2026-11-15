import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ChatTagToggleButton from '../ChatTagToggleButton.svelte';

describe('ChatTagToggleButton', () => {
	it('keeps the compact default icon-only and exposes the session row label and editor expansion', async () => {
		const onToggle = vi.fn();
		const view = render(ChatTagToggleButton, { active: false, onToggle });
		const button = screen.getByRole('button', { name: 'Add tags' });
		expect(button.textContent?.trim()).toBe('');
		expect(button.hasAttribute('aria-expanded')).toBe(false);

		await view.rerender({
			active: false,
			presentation: 'session-row',
			label: 'Add tags to session',
			open: false,
			onToggle,
		});
		expect(screen.getByRole('button', { name: 'Add tags to session' })).toBe(button);
		expect(screen.getByText('Add tags to session')).toBeTruthy();
		expect(button.getAttribute('aria-expanded')).toBe('false');
		await fireEvent.click(button);
		expect(onToggle).toHaveBeenCalledOnce();
		await view.rerender({ open: true, active: true });
		expect(button.getAttribute('aria-expanded')).toBe('true');
	});
});
