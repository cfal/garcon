import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';
import type { GitQuickSummaryReady } from '$lib/api/git.js';
import { chatDraftStorageKey } from '$lib/utils/local-persistence.js';
import * as snippetsApi from '$lib/api/snippets';

const appCss = readFileSync('src/app.css', 'utf8');

vi.mock('$lib/api/snippets', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/snippets')>();
	return { ...actual, expandSnippet: vi.fn() };
});

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
		vi.mocked(snippetsApi.expandSnippet).mockReset();
		document.querySelector('[data-testid="outside-focus"]')?.remove();
	});

	it('renders without a surface shadow', () => {
		const { container } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
		});
		const composer = container.querySelector('[data-composer]');

		expect(composer?.className).toContain('shadow-none');
		expect(composer?.className).not.toContain('shadow-sm');
	});

	it('resizes and reveals a draft block appended from another surface', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-append',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 420 });
		textarea.style.height = '48px';

		await fireEvent.click(screen.getByTestId('append-draft'));
		await nextAnimationFrame();

		expect(textarea.value).toBe('Appended review block');
		expect(textarea.style.height).toBe('300px');
		expect(textarea.scrollTop).toBe(420);
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
		expect(
			(screen.getByRole('button', { name: 'Add to prompt' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(document.activeElement).toBe(outsideButton);

		await rerender({
			selectedChatId: 'chat-2',
			selectedStatus: 'draft',
			isSubmitting: false,
		});
		await expectComposerFocus(textarea);
		expect(
			(screen.getByRole('button', { name: 'Add to prompt' }) as HTMLButtonElement).disabled,
		).toBe(false);

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

	it('keeps the composer rounded while status trays underlap it', async () => {
		const { container, rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
			quickCommitTrayVisible: false,
		});
		const composer = container.querySelector('[data-composer]');
		const processingTray = screen.getByRole('status');

		expect(composer).toBeTruthy();
		expect(composer?.className).toContain('rounded-2xl');
		expect(composer?.className).toContain('z-20');
		expect(composer?.className).not.toContain('rounded-t-none');
		expect(processingTray.parentElement?.className).toContain('bottom-full');
		expect(processingTray.parentElement?.className).toContain('translate-y-3');
		expect(processingTray.parentElement?.className).toContain('z-10');
		expect(processingTray.className).toContain('min-h-14');
		expect(processingTray.className).toContain('border-b-0');
		expect(processingTray.className).toContain('pb-5');

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: false,
			isSubmitting: false,
			quickCommitTrayVisible: true,
			quickCommitSummary: quickSummary(),
		});
		const gitTray = screen.getByRole('status');

		expect(composer?.className).toContain('rounded-2xl');
		expect(composer?.className).not.toContain('rounded-t-none');
		expect(gitTray.parentElement?.className).toContain('bottom-full');
		expect(gitTray.parentElement?.className).toContain('translate-y-3');
		expect(gitTray.parentElement?.className).toContain('z-10');
		expect(gitTray.className).toContain('min-h-14');
		expect(gitTray.className).toContain('border-b-0');
		expect(gitTray.className).toContain('pb-5');
	});

	it('always decorates processing and uses the static treatment when motion is reduced', async () => {
		const { container, rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: false,
			isSubmitting: false,
			reduceMotion: false,
		});
		const frame = container.querySelector('[data-composer]')?.parentElement;

		expect(frame?.className).not.toContain('composer-thinking-active');
		expect(frame?.className).not.toContain('composer-reduce-motion');

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
			reduceMotion: false,
		});
		expect(frame?.className).toContain('composer-thinking-active');
		expect(frame?.className).not.toContain('composer-reduce-motion');

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
			reduceMotion: true,
		});
		expect(frame?.className).toContain('composer-thinking-active');
		expect(frame?.className).toContain('composer-reduce-motion');
	});

	it('defaults to static and pulses only when motion is allowed', () => {
		const staticTreatmentRule = appCss.match(
			/\.composer-thinking-active\s*\{(?<body>[\s\S]*?)\n\}/,
		);
		const motionAllowedRule = appCss.match(
			/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.composer-thinking-active:not\(\.composer-reduce-motion\)\s*\{(?<body>[\s\S]*?)\n\t\}\s*\}/,
		);

		expect(appCss).toContain('@keyframes composer-thinking-border-pulse');
		expect(appCss).toMatch(
			/@keyframes composer-thinking-border-pulse\s*\{[\s\S]*?border-color: hsl\(var\(--border\)\);[\s\S]*?border-color: hsl\(var\(--composer-thinking-pulse-emphasis\)\);[\s\S]*?\}/,
		);
		expect(staticTreatmentRule?.groups?.body).toContain('--composer-thinking-animation: none;');
		expect(staticTreatmentRule?.groups?.body).toContain(
			'linear-gradient(hsl(var(--card)) 0 0) padding-box,',
		);
		expect(staticTreatmentRule?.groups?.body).toContain('to bottom,');
		expect(staticTreatmentRule?.groups?.body).toContain(
			'hsl(var(--composer-thinking-static-start)) 0%,',
		);
		expect(staticTreatmentRule?.groups?.body).toContain('hsl(var(--border)) 100%');
		expect(staticTreatmentRule?.groups?.body).toContain(
			'--composer-thinking-status-border: hsl(var(--composer-thinking-static-start));',
		);
		expect(motionAllowedRule?.groups?.body).toContain(
			'--composer-thinking-animation: composer-thinking-border-pulse 2.4s ease-in-out infinite;',
		);
		expect(motionAllowedRule?.groups?.body).not.toContain('composer-thinking-static-start');
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

	it('shows recent model selections in the active chat composer selector', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
			selectableAgents: ['claude', 'codex'],
			recentAgentSettings: [
				{
					agentId: 'claude',
					model: 'opus',
					apiProviderId: null,
					modelEndpointId: null,
					modelProtocol: null,
				},
				{
					agentId: 'codex',
					model: 'gpt-5',
					apiProviderId: null,
					modelEndpointId: null,
					modelProtocol: null,
				},
			],
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Opus/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Codex · OpenAI OAuth · GPT-5' })).toBeTruthy();
	});

	it('hides /fork using the selected chat agent capability', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedAgentId: 'amp',
			selectedStatus: 'running',
			isSubmitting: false,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await fireEvent.input(textarea, { target: { value: '/' } });

		expect(await screen.findByText('/compact')).toBeTruthy();
		expect(screen.queryByText('/fork')).toBeNull();
	});

	it('offers /in only for an existing chat', async () => {
		const { unmount } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			isSubmitting: false,
		});
		let textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/in' } });
		expect(await screen.findByText('/in')).toBeTruthy();
		unmount();

		render(PromptComposerTestHost, {
			selectedChatId: 'chat-draft',
			selectedStatus: 'draft',
			isSubmitting: false,
		});
		textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/in' } });
		expect(screen.queryByText('/in')).toBeNull();
	});

	it('flushes the latest textarea value to its chat draft on pagehide', async () => {
		localStorage.removeItem(chatDraftStorageKey('chat-draft-persist'));
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-draft-persist',
			selectedStatus: 'running',
			isSubmitting: false,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await fireEvent.input(textarea, { target: { value: 'survives refresh' } });
		window.dispatchEvent(new Event('pagehide'));

		expect(localStorage.getItem(chatDraftStorageKey('chat-draft-persist'))).toBe(
			'survives refresh',
		);
	});

	it('expands /s for review and sends only on a second explicit submit', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'Review the API in /workspace/project',
		});
		const onsubmit = vi.fn();
		const { container } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-review',
			selectedStatus: 'running',
			onsubmit,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		const attachment = new File(['review notes'], 'notes.pdf', { type: 'application/pdf' });
		await fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
			target: { files: [attachment] },
		});
		expect(screen.getByText('notes.pdf')).toBeTruthy();
		await fireEvent.input(textarea, { target: { value: '/s review the API' } });

		await fireEvent.keyDown(textarea, { key: 'Enter' });

		await waitFor(() => expect(textarea.value).toBe('Review the API in /workspace/project'));
		expect(screen.getByText('notes.pdf')).toBeTruthy();
		expect(onsubmit).not.toHaveBeenCalled();
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: 'the API',
				context: { type: 'chat', chatId: 'chat-snippet-review' },
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		expect(onsubmit).toHaveBeenCalledTimes(1);
	});

	it('locks the prompt during expansion and Escape preserves the invocation', async () => {
		const pending = deferredSnippetExpansion();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onsubmit = vi.fn();
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-cancel',
			selectedStatus: 'running',
			onsubmit,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/snippet review cancellable' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

		const pendingSend = await screen.findByRole('button', { name: 'Expanding snippet' });
		expect(textarea.readOnly).toBe(true);
		expect(textarea.getAttribute('aria-busy')).toBe('true');
		expect((pendingSend as HTMLButtonElement).disabled).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Add to prompt' }) as HTMLButtonElement).disabled,
		).toBe(true);

		await fireEvent.keyDown(textarea, { key: 'Escape' });
		expect(textarea.value).toBe('/snippet review cancellable');
		expect(textarea.readOnly).toBe(false);
		expect(onsubmit).not.toHaveBeenCalled();

		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});
		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(textarea.value).toBe('/snippet review cancellable');
	});

	it('lets another composer control cancel a pending expansion with Escape', async () => {
		const pending = deferredSnippetExpansion();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onsubmit = vi.fn();
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-control-cancel',
			selectedStatus: 'running',
			onsubmit,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/snippet review cancellable' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		await screen.findByRole('button', { name: 'Expanding snippet' });
		expect(document.activeElement).toBe(textarea);

		const permissionButton = screen.getAllByTitle('Default')[0];
		expect(permissionButton).toBeTruthy();
		if (!permissionButton) throw new Error('Missing permission control');
		permissionButton.focus();
		await fireEvent.keyDown(permissionButton, { key: 'Escape' });

		expect(textarea.value).toBe('/snippet review cancellable');
		expect(textarea.readOnly).toBe(false);
		expect(onsubmit).not.toHaveBeenCalled();
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(textarea.value).toBe('/snippet review cancellable');
	});

	it('inserts a menu-selected snippet at the current selection without sending', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'EXPANDED',
		});
		const onsubmit = vi.fn();
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-insert',
			selectedStatus: 'running',
			onsubmit,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Before replace after' } });
		textarea.setSelectionRange(7, 14);
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		const snippetsItem = await screen.findByRole('menuitem', { name: /Snippets/ });
		await fireEvent.pointerMove(snippetsItem, { pointerType: 'mouse' });
		await fireEvent.click(await screen.findByRole('menuitem', { name: /^review\b/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'the API' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await waitFor(() => expect(textarea.value).toBe('Before EXPANDED after'));
		expect(textarea.selectionStart).toBe('Before EXPANDED'.length);
		expect(onsubmit).not.toHaveBeenCalled();
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: 'the API',
				context: { type: 'chat', chatId: 'chat-snippet-insert' },
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('preserves the invocation and reports a failed expansion', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockRejectedValueOnce(new Error('server unavailable'));
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-error',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/snippet review keep this' } });

		await fireEvent.keyDown(textarea, { key: 'Enter' });

		await screen.findByText('Snippet expansion failed: server unavailable');
		expect(textarea.value).toBe('/snippet review keep this');
		expect(textarea.readOnly).toBe(false);
		expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
	});

	it('rejects a menu expansion when the selected snippet identity changed', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'replacement-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-replaced',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		const snippetsItem = await screen.findByRole('menuitem', { name: /Snippets/ });
		await fireEvent.pointerMove(snippetsItem, { pointerType: 'mouse' });
		await fireEvent.click(await screen.findByRole('menuitem', { name: /^review\b/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'current draft' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText('That snippet changed. Select it again.');
		await waitFor(() => expect(screen.getByTestId('snippet-load-count').textContent).toBe('2'));
		expect(textarea.value).toBe('Keep this draft');
	});

	it('rejects a menu expansion when the selected snippet was edited in place', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-02T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-edited',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(await screen.findByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});
		await fireEvent.click(await screen.findByRole('menuitem', { name: /^review\b/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'current draft' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText('That snippet changed. Select it again.');
		await waitFor(() => expect(screen.getByTestId('snippet-load-count').textContent).toBe('2'));
		expect(textarea.value).toBe('Keep this draft');
	});

	it('closes argument entry when the initiating chat changes', async () => {
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-dialog-one',
			selectedStatus: 'running',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(await screen.findByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});
		await fireEvent.click(await screen.findByRole('menuitem', { name: /^review\b/ }));
		await fireEvent.input(await screen.findByRole('textbox', { name: 'Arguments' }), {
			target: { value: 'old chat arguments' },
		});

		await rerender({
			selectedChatId: 'chat-snippet-dialog-two',
			selectedStatus: 'running',
		});

		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull());
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
	});

	it('restores focus when menu insertion has no project path', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-menu-missing-path',
			selectedStatus: 'running',
			projectPath: '   ',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(await screen.findByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});
		await fireEvent.click(await screen.findByRole('menuitem', { name: /^review\b/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'missing path' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText('Project path is required.');
		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
		expect(textarea.value).toBe('Keep this draft');
	});

	it('reopens argument entry with the original text after a request failure', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockRejectedValueOnce(new Error('server unavailable'));
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-menu-error',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(await screen.findByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});
		await fireEvent.click(await screen.findByRole('menuitem', { name: /^review\b/ }));
		const rawArguments = '  retry\nthese arguments  ';
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: rawArguments } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText('Snippet expansion failed: server unavailable');
		const reopened = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		expect(reopened.value).toBe(rawArguments);
		expect(textarea.value).toBe('Keep this draft');
	});

	it('rejects a response expanded for an intervening server project path', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/two',
			expandedText: 'must not apply',
		});
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-path-reused',
			selectedStatus: 'running',
			projectPath: '/workspace/one',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(await screen.findByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});
		await fireEvent.click(await screen.findByRole('menuitem', { name: /^review\b/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'path race' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull());
		expect(textarea.value).toBe('Keep this draft');
	});

	it('reports a missing project path instead of swallowing a snippet command', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-missing-path',
			selectedStatus: 'running',
			projectPath: '',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/snippet review this' } });

		await fireEvent.keyDown(textarea, { key: 'Enter' });

		await screen.findByText('Project path is required.');
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
		expect(textarea.value).toBe('/snippet review this');
	});

	it('does not apply an expansion after switching chats', async () => {
		const pending = deferredSnippetExpansion();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-switch-one',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/snippet review old chat' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		await screen.findByRole('button', { name: 'Expanding snippet' });

		await rerender({
			selectedChatId: 'chat-snippet-switch-two',
			selectedStatus: 'running',
		});
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not cross chats',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(textarea.value).not.toBe('must not cross chats');
	});

	it('does not apply an expansion after the selected chat project path changes', async () => {
		const pending = deferredSnippetExpansion();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-path-change',
			selectedStatus: 'running',
			projectPath: '/workspace/one',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/snippet review old path' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		await screen.findByRole('button', { name: 'Expanding snippet' });

		await rerender({
			selectedChatId: 'chat-snippet-path-change',
			selectedStatus: 'running',
			projectPath: '/workspace/two',
		});
		await waitFor(() => expect(textarea.readOnly).toBe(false));
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/one',
			expandedText: 'must not cross project paths',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(textarea.value).toBe('/snippet review old path');
	});
});

function deferredSnippetExpansion() {
	let resolve!: (value: Awaited<ReturnType<typeof snippetsApi.expandSnippet>>) => void;
	const promise = new Promise<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
