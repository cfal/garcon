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

	it('renders the floating toolbar reservation inside scrollable feed content', () => {
		const { container } = render(ConversationFeedTestHost, {
			reserveTopFloatingToolbar: true,
		});

		const viewport = screen.getByRole('log');
		const spacer = container.querySelector<HTMLElement>(
			'[data-chat-feed-top-floating-toolbar-spacer]',
		);
		const bottomAnchor = container.querySelector<HTMLElement>('[data-chat-bottom-anchor]');

		expect(spacer).toBeTruthy();
		expect(bottomAnchor).toBeTruthy();
		expect(viewport.contains(spacer)).toBe(true);
		expect(viewport.contains(bottomAnchor)).toBe(true);
		expect(spacer?.classList.contains('h-[var(--workspace-floating-taskbar-inset)]')).toBe(true);
		expect(spacer?.compareDocumentPosition(bottomAnchor as Node)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});
});
