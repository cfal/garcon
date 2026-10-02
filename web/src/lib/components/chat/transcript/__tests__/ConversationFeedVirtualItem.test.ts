import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ConversationFeedVirtualPermissionTestHost from './ConversationFeedVirtualPermissionTestHost.svelte';

const SOURCE_CHAT_ID = '1788592720180699';
const TARGET_CHAT_ID = '1788592720180600';

describe('ConversationFeedVirtualItem', () => {
	afterEach(() => {
		cleanup();
	});

	it('uses the rendered chat context for floating permission references', () => {
		const { container } = render(ConversationFeedVirtualPermissionTestHost);

		expect(screen.getByText('Current').closest('a')).toBeNull();
		expect(
			container.querySelector(`span[data-chat-reference-id="${SOURCE_CHAT_ID}"]`),
		).not.toBeNull();
		expect(screen.getByRole('link', { name: 'Other' }).getAttribute('href')).toBe(
			`/chat/${TARGET_CHAT_ID}`,
		);
	});
});
