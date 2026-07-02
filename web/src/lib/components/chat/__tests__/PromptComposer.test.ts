import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';
import type { GitQuickSummaryReady } from '$lib/api/git.js';

function nextAnimationFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

async function expectComposerFocus(textarea: HTMLElement): Promise<void> {
	await nextAnimationFrame();
	await waitFor(() => {
		expect(document.activeElement).toBe(textarea);
	});
}

function quickSummary(overrides: Partial<GitQuickSummaryReady> = {}): GitQuickSummaryReady {
	return {
		status: 'ready',
		project: '/workspace/project',
		repoRoot: '/workspace/project',
		branch: 'main',
		hasCommits: true,
		changedFiles: 1,
		trackedChangedFiles: 1,
		untrackedFiles: 0,
		stagedFiles: 0,
		unstagedFiles: 1,
		additions: 1,
		deletions: 0,
		fingerprintVersion: 1,
		fingerprint: 'v1:test',
		...overrides,
	};
}

describe('PromptComposer focus', () => {
	afterEach(() => {
		cleanup();
		document.querySelector('[data-testid="outside-focus"]')?.remove();
	});

	it('focuses the composer after disabled chat startup and on each next selected chat', async () => {
		const outsideButton = document.createElement('button');
		outsideButton.dataset.testid = 'outside-focus';
		outsideButton.textContent = 'Outside focus';
		document.body.append(outsideButton);

		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await expectComposerFocus(textarea);

		outsideButton.focus();
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-2',
			selectedStatus: 'draft',
			isSubmitting: true,
		});
		await nextAnimationFrame();

		expect(textarea.disabled).toBe(true);
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-2',
			selectedStatus: 'draft',
			isSubmitting: false,
		});
		await expectComposerFocus(textarea);

		for (const chatId of ['chat-3', 'chat-4', 'chat-5']) {
			outsideButton.focus();
			expect(document.activeElement).toBe(outsideButton);

			await rerender({
				selectedChatId: chatId,
				selectedStatus: 'running',
				isSubmitting: false,
			});
			await expectComposerFocus(textarea);
		}
	});

	it('retries app-shell focus requests after the selected chat becomes enabled', async () => {
		const outsideButton = document.createElement('button');
		outsideButton.dataset.testid = 'outside-focus';
		outsideButton.textContent = 'Outside focus';
		document.body.append(outsideButton);

		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'draft',
			isSubmitting: true,
			focusRequestToken: 0,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		outsideButton.focus();
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'draft',
			isSubmitting: true,
			focusRequestToken: 1,
		});
		await nextAnimationFrame();

		expect(textarea.disabled).toBe(true);
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'draft',
			isSubmitting: false,
			focusRequestToken: 1,
		});
		await expectComposerFocus(textarea);
	});

	it('keeps focused input editable while quick commit tray props refresh', async () => {
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
			quickCommitTrayVisible: true,
			quickCommitSummary: quickSummary(),
			quickCommitRefreshing: false,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await expectComposerFocus(textarea);
		await fireEvent.input(textarea, { target: { value: 'first' } });
		expect(textarea.value).toBe('first');

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
			quickCommitTrayVisible: true,
			quickCommitSummary: quickSummary({ fingerprint: 'v1:refreshing' }),
			quickCommitRefreshing: true,
		});
		await expectComposerFocus(textarea);
		await fireEvent.input(textarea, { target: { value: 'first second' } });

		expect(textarea.value).toBe('first second');
	});

	it('shows quick commit before stop while the selected chat is processing', async () => {
		const onAbort = vi.fn();
		const onQuickCommit = vi.fn();
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
			quickCommitTrayVisible: false,
			quickCommitSummary: quickSummary({ additions: 3, deletions: 1 }),
			onAbort,
			onQuickCommit,
		});

		const commitButton = screen.getByRole('button', { name: 'Commit' });
		const stopButton = screen.getByRole('button', { name: 'Stop' });

		expect(
			commitButton.compareDocumentPosition(stopButton) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(commitButton.textContent).toContain('+3');
		expect(commitButton.textContent).toContain('/');
		expect(commitButton.textContent).toContain('-1');
		expect(commitButton.textContent).not.toContain('Commit');
		expect(screen.getByText('+3').className).toContain('text-git-added');
		expect(screen.getByText('-1').className).toContain('text-git-deleted');

		await fireEvent.click(commitButton);

		expect(onQuickCommit).toHaveBeenCalledOnce();
		expect(onAbort).not.toHaveBeenCalled();
	});

	it('hides quick commit while processing when the ready summary has no changes', () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
			quickCommitTrayVisible: false,
			quickCommitSummary: quickSummary({
				changedFiles: 0,
				trackedChangedFiles: 0,
				untrackedFiles: 0,
				stagedFiles: 0,
				unstagedFiles: 0,
				additions: 0,
				deletions: 0,
			}),
			onQuickCommit: vi.fn(),
		});

		expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
	});

	it('defers focus while hidden and focuses once the composer becomes visible', async () => {
		const outsideButton = document.createElement('button');
		outsideButton.dataset.testid = 'outside-focus';
		document.body.append(outsideButton);
		outsideButton.focus();

		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
			isVisible: false,
			focusRequestToken: 1,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		// While hidden (e.g. the Git tab is active) the focus request must not be
		// consumed against a display:none textarea, so focus stays put.
		await nextAnimationFrame();
		await nextAnimationFrame();
		expect(document.activeElement).not.toBe(textarea);

		// Returning to the chat tab makes the composer visible and the pending
		// request focuses it, so the user can type immediately.
		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
			isVisible: true,
			focusRequestToken: 1,
		});
		await expectComposerFocus(textarea);
	});

	it('keeps input editable when a focus request arrives while already focused', async () => {
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
			focusRequestToken: 0,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await expectComposerFocus(textarea);
		await fireEvent.input(textarea, { target: { value: 'before refocus' } });

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
			focusRequestToken: 1,
		});
		await expectComposerFocus(textarea);
		await fireEvent.input(textarea, { target: { value: 'after refocus' } });

		expect(textarea.value).toBe('after refocus');
	});
});
