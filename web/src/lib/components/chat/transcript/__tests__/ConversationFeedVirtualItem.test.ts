import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConversationFeedVirtualPermissionTestHost from './ConversationFeedVirtualPermissionTestHost.svelte';

const SOURCE_CHAT_ID = '1788592720180699';
const TARGET_CHAT_ID = '1788592720180600';

describe('ConversationFeedVirtualItem', () => {
	afterEach(() => {
		cleanup();
	});

	it('forwards approval and new-chat commands from a floating plan without a prepared window', async () => {
		const onExitPlanMode = vi.fn(), onPermissionDecision = vi.fn();
		render(ConversationFeedVirtualPermissionTestHost, { onExitPlanMode, onPermissionDecision });
		await fireEvent.click(screen.getByRole('button', { name: 'Yes, approve edits' }));
		expect(onExitPlanMode).toHaveBeenCalledWith('permission-chat-links', 'approve-edits', expect.stringContaining('[Current]'));
		await fireEvent.click(screen.getByRole('button', { name: /new session/i }));
		expect(onExitPlanMode).toHaveBeenLastCalledWith('permission-chat-links', 'bypass-new', expect.stringContaining('[Current]'));
		expect(screen.queryByRole('button', { name: /^Deny$/ })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Revise plan' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: /^Dismiss$/ }));
		expect(onExitPlanMode).toHaveBeenLastCalledWith('permission-chat-links', 'dismiss', '');
		expect(onPermissionDecision).not.toHaveBeenCalled();
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
