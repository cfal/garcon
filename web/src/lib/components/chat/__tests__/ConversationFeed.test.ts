import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ConversationFeedTestHost from './ConversationFeedTestHost.svelte';

describe('ConversationFeed loading status spacing', () => {
	it('reserves bottom padding only when loading status space is requested', async () => {
		const { rerender } = render(ConversationFeedTestHost, {
			reserveLoadingStatusSpace: false,
		});
		const viewport = screen.getByRole('log');

		expect(viewport.className).not.toContain('pb-14');

		await rerender({ reserveLoadingStatusSpace: true });
		expect(viewport.className).toContain('pb-14');
	});
});
