import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
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
});
