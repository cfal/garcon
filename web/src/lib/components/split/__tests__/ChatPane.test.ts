import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ChatPaneTestHarness from './ChatPaneTestHarness.svelte';

describe('ChatPane', () => {
	it('shows chat history and a composer target when unfocused', async () => {
		const onFocus = vi.fn();
		render(ChatPaneTestHarness, { isFocused: false, onFocus });

		const composerTarget = screen.getByRole('button', {
			name: 'Focus chat composer for Pane Test Chat',
		});

		expect(document.querySelector('[data-pane-body]')).toBeTruthy();
		expect(await screen.findByText('Unfocused user question')).toBeTruthy();
		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(screen.getByText('Reply...')).toBeTruthy();

		await fireEvent.click(composerTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('renders the full workspace for the focused pane', () => {
		render(ChatPaneTestHarness, { isFocused: true });

		expect(screen.getByTestId('focused-workspace')).toBeTruthy();
		expect(screen.queryByText('Reply...')).toBeNull();
	});
});
