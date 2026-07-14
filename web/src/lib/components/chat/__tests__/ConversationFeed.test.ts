import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import ConversationFeedTestHost from './ConversationFeedTestHost.svelte';

describe('ConversationFeed', () => {
	afterEach(() => {
		cleanup();
	});

	it('omits the top floating toolbar spacer by default', () => {
		const { container } = render(ConversationFeedTestHost);

		expect(container.querySelector('[data-chat-feed-top-floating-toolbar-spacer]')).toBeNull();
	});

	it('keeps the feed log and bottom anchor in the normal content flow', () => {
		const { container } = render(ConversationFeedTestHost);
		const viewport = screen.getByRole('log');
		const bottomAnchor = container.querySelector<HTMLElement>('[data-chat-bottom-anchor]');

		expect(bottomAnchor).toBeTruthy();
		expect(viewport.contains(bottomAnchor)).toBe(true);
	});
});
