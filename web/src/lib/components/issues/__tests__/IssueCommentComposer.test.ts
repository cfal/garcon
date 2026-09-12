import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import IssueCommentComposer from '../IssueCommentComposer.svelte';
import { issueTestHarness, ISSUE_STORE, syntheticIssue } from './issue-test-harness';
import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte';

const controllers: IssuesController[] = [];
afterEach(() => {
	cleanup();
	for (const controller of controllers.splice(0)) controller.dispose();
});
describe('Issue comment submission', () => {
	it('does not invoke a destroyed composer’s owner after its request settles', async () => {
		const { controller, api } = issueTestHarness();
		controllers.push(controller);
		controller.drafts.setPartition({ storeId: ISSUE_STORE, viewerKey: 'synthetic-viewer' });
		const draft = controller.drafts.open('comment', { issue: syntheticIssue() })!;
		const onSubmitted = vi.fn();
		const view = render(IssueCommentComposer, { draft, onSubmitted });
		draft.setField('body', 'Held comment');
		let release!: () => void;
		const mutate = api.mutate.getMockImplementation()!;
		api.mutate.mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return mutate(...args);
		});
		await fireEvent.submit(screen.getByRole('textbox').closest('form')!);
		view.unmount();
		release();
		await vi.waitFor(() => expect(draft.pending).toBe(false));
		expect(draft.dirty).toBe(false);
		expect(onSubmitted).not.toHaveBeenCalled();
	});

	it('shares the click/shortcut gate, keeps multiline Enter, excludes IME, and prevents duplicate submission', async () => {
		const { controller, api } = issueTestHarness();
		controllers.push(controller);
		controller.drafts.setPartition({ storeId: ISSUE_STORE, viewerKey: 'synthetic-viewer' });
		const draft = controller.drafts.open('comment', { issue: syntheticIssue() })!;
		render(IssueCommentComposer, { draft });
		const input = screen.getByRole('textbox');
		await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
		expect(api.mutate).not.toHaveBeenCalled();
		await fireEvent.input(input, { target: { value: 'Synthetic\ncomment' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(api.mutate).not.toHaveBeenCalled();
		await fireEvent.compositionStart(input);
		await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
		await fireEvent.submit(input.closest('form')!);
		expect(api.mutate).not.toHaveBeenCalled();
		await fireEvent.compositionEnd(input);
		let release!: () => void;
		api.mutate.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => (release = resolve));
			return {
				success: true,
				storeId: ISSUE_STORE,
				collectionRevision: 2,
				issue: syntheticIssue(),
			};
		});
		await fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
		await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
		expect(api.mutate).toHaveBeenCalledTimes(1);
		expect(draft.field('body')).toBe('Synthetic\ncomment');
		release();
		await tick();
	});
});
