import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import EditorSettingsMenuWrapper from './EditorSettingsMenuWrapper.svelte';

describe('EditorSettingsMenu', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('renders gear trigger with accessible label', () => {
		render(EditorSettingsMenuWrapper);

		const trigger = screen.getByLabelText('Editor settings');
		expect(trigger).toBeTruthy();
		expect(trigger.getAttribute('title')).toBe('Editor settings');
	});

	it('renders a checkmark only while Word wrap is enabled', async () => {
		render(EditorSettingsMenuWrapper);
		await fireEvent.click(screen.getByLabelText('Editor settings'));
		const wordWrap = screen.getByRole('menuitemcheckbox', { name: 'Word wrap' });
		const lineNumbers = screen.getByRole('menuitemcheckbox', { name: 'Line numbers' });

		expect(wordWrap.getAttribute('aria-checked')).toBe('false');
		expect(wordWrap.querySelector('svg')).toBeNull();
		expect(lineNumbers.querySelector('svg')).not.toBeNull();

		await fireEvent.click(wordWrap);
		expect(wordWrap.getAttribute('aria-checked')).toBe('true');
		expect(wordWrap.querySelector('svg')).not.toBeNull();

		await fireEvent.click(wordWrap);
		expect(wordWrap.getAttribute('aria-checked')).toBe('false');
		expect(wordWrap.querySelector('svg')).toBeNull();
		expect(lineNumbers.getAttribute('aria-checked')).toBe('true');
	});
});
