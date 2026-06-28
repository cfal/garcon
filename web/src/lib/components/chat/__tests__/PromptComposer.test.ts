import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
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

	it('renders quick commit row inside the composer while processing', () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
			quickCommitTrayVisible: true,
			quickCommitSummary: quickSummary(),
			quickCommitRefreshing: false,
		});

		const composer = screen.getByRole('textbox').closest('[data-composer]');
		expect(composer).toBeTruthy();
		const row = composer?.querySelector('[data-git-quick-status-row]');
		expect(row).toBeTruthy();
		expect(screen.getByText('main')).toBeTruthy();
	});

	it('reserves quick commit slot while summary loads without expanding the composer allocation', () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
			quickCommitTrayVisible: true,
			quickCommitSummary: null,
			quickCommitRefreshing: true,
		});

		const composer = screen.getByRole('textbox').closest('[data-composer]');
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		const row = composer?.querySelector('[data-git-quick-status-row]');

		expect(row).toBeTruthy();
		expect(row).toBe(screen.getByRole('status', { name: 'Loading...' }));
		expect(screen.queryByText('main')).toBeNull();
		expect(textarea.style.minHeight).toBe('100px');
		expect(textarea.style.maxHeight).toBe('460px');
	});

	it('keeps the thinking indicator outside the composer surface', () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
			quickCommitTrayVisible: true,
			quickCommitSummary: quickSummary(),
			quickCommitRefreshing: false,
		});

		const composer = screen.getByRole('textbox').closest('[data-composer]');
		const statusRegions = screen.getAllByRole('status');
		expect(statusRegions.some((region) => composer?.contains(region))).toBe(true);
		expect(statusRegions.some((region) => !composer?.contains(region))).toBe(true);
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
