import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/components/chat/ConversationTranscript.svelte', async () => ({
	default: (await import('./ConversationTranscriptRowsStub.svelte')).default,
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
			transcriptScenario: 'row-ids',
		});

		const viewport = screen.getByRole('log');
		const spacer = container.querySelector<HTMLElement>(
			'[data-chat-feed-top-floating-toolbar-spacer]',
		);
		const transcript = container.querySelector<HTMLElement>('[data-conversation-transcript]');

		expect(spacer).toBeTruthy();
		expect(transcript).toBeTruthy();
		expect(viewport.contains(spacer)).toBe(true);
		expect(viewport.contains(transcript)).toBe(true);
		expect(spacer?.classList.contains('h-[var(--workspace-floating-taskbar-inset)]')).toBe(true);
		expect(spacer?.compareDocumentPosition(transcript as Node)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(container.querySelector('[data-chat-bottom-anchor]')).toBeNull();
	});

	it('hides the local truncation control during the automatic initial reveal', () => {
		render(ConversationFeedTestHost, { transcriptScenario: 'initial-reveal' });

		expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
	});

	it('shows a directional earlier boundary after the automatic reveal window', () => {
		render(ConversationFeedTestHost, { transcriptScenario: 'local-truncation' });

		expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeTruthy();
		expect(screen.queryByText('Load more')).toBeNull();
	});

	it('renders later loading below the transcript without a native bottom anchor', () => {
		const { container } = render(ConversationFeedTestHost, {
			transcriptScenario: 'loading-later',
		});
		const transcript = container.querySelector('[data-conversation-transcript]');
		const boundary = container.querySelector('[data-transcript-page-boundary="later"]');

		expect(screen.getByText('Loading later messages...')).toBeTruthy();
		expect(screen.getByRole('log').getAttribute('aria-busy')).toBe('true');
		expect(transcript?.compareDocumentPosition(boundary as Node)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(container.querySelector('[data-chat-bottom-anchor]')).toBeNull();
	});

	it('keeps an earlier failure in flow as a directional retry', () => {
		render(ConversationFeedTestHost, { transcriptScenario: 'error-earlier' });

		expect(screen.getByRole('button', { name: 'Retry earlier messages' })).toBeTruthy();
	});

	it('passes durable and pending row identities to the transcript renderer', () => {
		const { container } = render(ConversationFeedTestHost, { transcriptScenario: 'row-ids' });

		expect(
			Array.from(
				container.querySelectorAll<HTMLElement>('[data-transcript-row-id]'),
				(row) => row.dataset.transcriptRowId,
			),
		).toEqual(['generation-1:1', 'pending:request-1']);
	});
});
