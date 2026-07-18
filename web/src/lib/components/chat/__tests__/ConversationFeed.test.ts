import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/components/chat/ConversationTranscript.svelte', async () => ({
	default: (await import('./GenericStub.svelte')).default,
}));

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

	it('hides the local truncation control during the automatic initial reveal', () => {
		render(ConversationFeedTestHost, { transcriptScenario: 'initial-reveal' });

		expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
	});

	it('still shows the local truncation control after the automatic reveal window', () => {
		render(ConversationFeedTestHost, { transcriptScenario: 'local-truncation' });

		expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy();
	});
});
