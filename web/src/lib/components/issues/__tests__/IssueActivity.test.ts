import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import IssueActivity from '../IssueActivity.svelte';
import { issueTestHarness, syntheticIssue } from './issue-test-harness.js';

afterEach(cleanup);
it('opens the recorded source only on activation and disables deleted-chat navigation', async () => {
	const { controller, api } = issueTestHarness();
	const source = {
		chatId: '1000000000000001',
		transcriptViewId: '11111111-1111-4111-8111-111111111111',
		ordinal: 7,
	};
	controller.detail.history = {
		storeId: 'synthetic-store',
		collectionRevision: 1,
		nextBeforeSequence: null,
		items: [
			{
				sequence: 1,
				issueId: 'G-1',
				at: '2026-01-01T00:00:00.000Z',
				actor: syntheticIssue().createdBy,
				source,
				action: 'created',
				issue: syntheticIssue(),
			},
		],
	};
	const onOpenSource = vi.fn();
	const props = {
		controller,
		chats: [{ id: source.chatId, title: 'Synthetic chat' }],
		username: 'local',
		onOpenChat: vi.fn(),
		onOpenSource,
	};
	const view = render(IssueActivity, props);
	expect(api.history).not.toHaveBeenCalled();
	expect(onOpenSource).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
	expect(onOpenSource).toHaveBeenCalledExactlyOnceWith(source);
	await view.rerender({ ...props, chats: [] });
	expect(screen.getByRole('button', { name: 'Open source' }).hasAttribute('disabled')).toBe(true);
	controller.dispose();
});
