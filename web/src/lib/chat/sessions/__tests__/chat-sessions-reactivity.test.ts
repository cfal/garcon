import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ChatSessionsReactivityTestHost from './ChatSessionsReactivityTestHost.svelte';

describe('ChatSessionsStore collection reactivity', () => {
	afterEach(cleanup);

	it('reacts to processing events before the chat record hydrates', async () => {
		render(ChatSessionsReactivityTestHost);
		const processing = screen.getByTestId('pending-processing');
		expect(processing.textContent).toBe('false');
		await fireEvent.click(screen.getByRole('button', { name: 'Start pending' }));
		expect(processing.textContent).toBe('true');
		await fireEvent.click(screen.getByRole('button', { name: 'Stop pending' }));
		expect(processing.textContent).toBe('false');
	});

	it('updates selected, ordered, unread, and Sidebar consumers after replacements', async () => {
		render(ChatSessionsReactivityTestHost);

		expect(screen.getByTestId('selected-title').textContent).toBe('Alpha');
		expect(screen.getByTestId('selected-unread').textContent).toBe('false');
		expect(screen.getByTestId('ordered-ids').textContent).toBe('alpha');
		expect(screen.getByTestId('sidebar-ids').textContent).toBe('alpha');

		await fireEvent.click(screen.getByRole('button', { name: 'Replace collections' }));

		expect(screen.getByTestId('selected-title').textContent).toBe('Alpha updated');
		expect(screen.getByTestId('selected-unread').textContent).toBe('true');
		expect(screen.getByTestId('ordered-ids').textContent).toBe('beta,alpha');
		expect(screen.getByTestId('sidebar-ids').textContent).toBe('beta,alpha');
	});
});
