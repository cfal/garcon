import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ChatLoadingState from '../ChatLoadingState.svelte';

describe('ChatLoadingState', () => {
	afterEach(cleanup);

	it('keeps non-anchor loading panels visible without announcing them', () => {
		const { container } = render(ChatLoadingState, { announcementsEnabled: false });

		expect(screen.getByText('Loading chats...')).toBeTruthy();
		expect(screen.queryByRole('status')).toBeNull();
		expect(container.firstElementChild?.getAttribute('aria-live')).toBe('off');
	});
});
