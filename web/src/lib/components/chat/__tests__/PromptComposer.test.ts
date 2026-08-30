import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';
import {
	emitLastPromptEditorTextChange,
	resetPromptEditorStub,
} from '$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte';
import type { GitQuickSummaryReady } from '$lib/api/git.js';
import { ImageAttachmentState } from '$lib/chat/composer/image-attachment.svelte.js';
import { chatDraftStorageKey, LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence.js';
import * as snippetsApi from '$lib/api/snippets';

const appCss = readFileSync('src/app.css', 'utf8');

vi.mock('$lib/api/snippets', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/snippets')>();
	return { ...actual, expandSnippet: vi.fn() };
});

vi.mock('$lib/components/prompt-editor/PromptEditor.svelte', async () => ({
	default: (await import('$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte'))
		.default,
}));

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

async function inputAtCaret(
	textarea: HTMLTextAreaElement,
	value: string,
	caret: number,
	eventInit: InputEventInit = {},
): Promise<void> {
	textarea.value = value;
	textarea.setSelectionRange(caret, caret);
	await fireEvent.input(textarea, eventInit);
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
		resetPromptEditorStub();
		vi.mocked(snippetsApi.expandSnippet).mockReset();
		document.querySelector('[data-testid="outside-focus"]')?.remove();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.composerHeight);
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

	it('keeps manual resizing live after content auto-expands while the selected chat is processing', async () => {
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		const slider = screen.getByRole('slider', { name: 'Resize message composer' });
		slider.setPointerCapture = vi.fn();
		slider.hasPointerCapture = vi.fn(() => true);
		slider.releasePointerCapture = vi.fn();
		Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 420 });

		await fireEvent.input(textarea, { target: { value: 'A long prompt' } });
		expect(textarea.style.height).toBe('300px');
		await fireEvent.pointerDown(slider, {
			pointerId: 11,
			clientY: 400,
			button: 0,
			isPrimary: true,
		});
		await fireEvent.pointerMove(slider, { pointerId: 11, clientY: 540 });

		expect(textarea.style.height).toBe('160px');
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.composerHeight)).toBeNull();

		await rerender({
			selectedChatId: 'chat-1',
			selectedStatus: 'running',
			selectedIsProcessing: true,
			isSubmitting: false,
			quickCommitRefreshing: true,
		});
		expect(textarea.style.height).toBe('160px');

		await fireEvent.pointerUp(slider, { pointerId: 11, clientY: 540 });

		expect(textarea.style.height).toBe('160px');
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.composerHeight)).toBe('160');
	});

	it('removes stale content height when the draft is cleared programmatically', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-programmatic-clear',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		Object.defineProperty(textarea, 'scrollHeight', {
			configurable: true,
			get: () => (textarea.value ? 420 : 48),
		});

		await fireEvent.input(textarea, { target: { value: 'A long prompt' } });
		expect(textarea.style.height).toBe('300px');

		await fireEvent.click(screen.getByTestId('clear-draft'));

		expect(textarea.value).toBe('');
		expect(textarea.style.height).toBe('140px');
	});

	it('does not resync attachment URLs for text-only draft changes', async () => {
		const syncUrls = vi.spyOn(ImageAttachmentState.prototype, 'syncUrls');
		try {
			const { container } = render(PromptComposerTestHost, {
				selectedChatId: 'chat-attachment-sync',
			});
			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			const attachment = new File(['notes'], 'notes.pdf', { type: 'application/pdf' });

			await fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
				target: { files: [attachment] },
			});
			await waitFor(() => expect(syncUrls).toHaveBeenCalledTimes(1));

			await fireEvent.input(textarea, { target: { value: 'Text-only change' } });
			await nextAnimationFrame();
			expect(syncUrls).toHaveBeenCalledTimes(1);

			await fireEvent.click(screen.getByRole('button', { name: /notes\.pdf/ }));
			await waitFor(() => expect(syncUrls).toHaveBeenCalledTimes(2));
		} finally {
			syncUrls.mockRestore();
		}
	});

	it('opens a live expanded editor and restores directional selection on Escape', async () => {
		const chatId = 'chat-expanded-live';
		localStorage.removeItem(chatDraftStorageKey(chatId));
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: chatId,
			composerEditorOpenRequestId: 0,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'alpha\nbeta' } });
		textarea.setSelectionRange(2, 7, 'backward');

		await rerender({ selectedChatId: chatId, composerEditorOpenRequestId: 1 });
		const editor = (await screen.findByRole('textbox', {
			name: 'Expanded composer text',
		})) as HTMLTextAreaElement;
		expect(editor.value).toBe('alpha\nbeta');
		editor.value = 'alpha\nbeta\ngamma';
		editor.setSelectionRange(3, 16, 'backward');
		await fireEvent.input(editor);
		await fireEvent.pointerUp(editor);
		await waitFor(() => expect(textarea.value).toBe('alpha\nbeta\ngamma'));
		await waitFor(() =>
			expect(localStorage.getItem(chatDraftStorageKey(chatId))).toBe('alpha\nbeta\ngamma'),
		);

		await fireEvent.keyDown(editor, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect(textarea.selectionStart).toBe(3);
		expect(textarea.selectionEnd).toBe(16);
		expect(textarea.selectionDirection).toBe('backward');
		localStorage.removeItem(chatDraftStorageKey(chatId));
	});

	it('synchronizes external composer changes without echoing a second revision', async () => {
		render(PromptComposerTestHost, { selectedChatId: 'chat-expanded-external' });
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'before' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const editor = await screen.findByRole('textbox', { name: 'Expanded composer text' });
		await fireEvent.input(textarea, { target: { value: 'external replacement' } });

		await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('external replacement'));
	});

	it('opens and refocuses the existing editor from monotonic workspace requests', async () => {
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-expanded-request',
			composerEditorOpenRequestId: 0,
		});

		await rerender({
			selectedChatId: 'chat-expanded-request',
			composerEditorOpenRequestId: 1,
		});
		const editor = await screen.findByRole('textbox', { name: 'Expanded composer text' });
		await waitFor(() => expect(document.activeElement).toBe(editor));
		screen.getByRole('button', { name: 'Close expanded editor' }).focus();

		await rerender({
			selectedChatId: 'chat-expanded-request',
			isVisible: false,
			isPresented: true,
			composerEditorOpenRequestId: 2,
		});
		expect(screen.getAllByRole('dialog')).toHaveLength(1);
		await waitFor(() => expect(document.activeElement).toBe(editor));

		await fireEvent.click(screen.getByRole('button', { name: 'Close expanded editor' }));
		await rerender({
			selectedChatId: 'chat-expanded-request',
			isVisible: true,
			isPresented: true,
			composerEditorOpenRequestId: 2,
		});
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('distinguishes modal interactivity from Chat surface presentation', async () => {
		const chatId = 'chat-expanded-presentation';
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: chatId,
			isVisible: true,
			isPresented: true,
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		await screen.findByRole('dialog');

		await rerender({ selectedChatId: chatId, isVisible: false, isPresented: true });
		expect(screen.getByRole('dialog')).toBeTruthy();

		await rerender({ selectedChatId: chatId, isVisible: false, isPresented: false });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('closes on chat switch and rejects late writes from the outgoing editor', async () => {
		const firstChatId = 'chat-expanded-switch-a';
		const secondChatId = 'chat-expanded-switch-b';
		const { rerender } = render(PromptComposerTestHost, { selectedChatId: firstChatId });
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'first draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		await screen.findByRole('dialog');

		await rerender({ selectedChatId: secondChatId });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await fireEvent.input(textarea, { target: { value: 'second draft' } });
		emitLastPromptEditorTextChange('stale first-chat write');

		expect(textarea.value).toBe('second draft');
		await waitFor(() =>
			expect(localStorage.getItem(chatDraftStorageKey(secondChatId))).toBe('second draft'),
		);
		expect(localStorage.getItem(chatDraftStorageKey(secondChatId))).not.toBe(
			'stale first-chat write',
		);
		localStorage.removeItem(chatDraftStorageKey(firstChatId));
		localStorage.removeItem(chatDraftStorageKey(secondChatId));
	});

	it('routes exact enabled Ctrl+Enter through steer-preferred submission', async () => {
		const onsubmit = vi.fn();
		const onSteerPreferredSubmit = vi.fn();
		render(PromptComposerTestHost, { onsubmit, onSteerPreferredSubmit });
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Focus on the failing test' } });
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});

		textarea.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(onSteerPreferredSubmit).toHaveBeenCalledOnce();
		expect(onsubmit).not.toHaveBeenCalled();
	});

	it('leaves Ctrl+Enter native when steer preference is disabled', async () => {
		const onsubmit = vi.fn();
		const onSteerPreferredSubmit = vi.fn();
		render(PromptComposerTestHost, {
			steerWithCtrlEnter: false,
			onsubmit,
			onSteerPreferredSubmit,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Keep editing' } });
		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});

		textarea.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(onSteerPreferredSubmit).not.toHaveBeenCalled();
		expect(onsubmit).not.toHaveBeenCalled();
	});

	it('applies the shared submit gate before Ctrl+Enter steering', async () => {
		const onSteerPreferredSubmit = vi.fn();
		const { rerender } = render(PromptComposerTestHost, { onSteerPreferredSubmit });
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(onSteerPreferredSubmit).not.toHaveBeenCalled();

		await rerender({ directAdmissionPending: true, onSteerPreferredSubmit });
		await fireEvent.input(textarea, { target: { value: 'Wait for admission' } });
		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(onSteerPreferredSubmit).not.toHaveBeenCalled();
	});

	it('gives completion menus first refusal over Ctrl+Enter', async () => {
		const onsubmit = vi.fn();
		const onSteerPreferredSubmit = vi.fn();
		render(PromptComposerTestHost, { onsubmit, onSteerPreferredSubmit });
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await inputAtCaret(textarea, '/', 1);
		await screen.findByText('/compact');

		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

		expect(onSteerPreferredSubmit).not.toHaveBeenCalled();
		expect(onsubmit).not.toHaveBeenCalled();
	});

	it('resizes and reveals a draft block appended from another surface', async () => {
		const { rerender } = render(PromptComposerTestHost, {
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

		textarea.scrollTop = 100;
		await rerender({
			selectedChatId: 'chat-append',
			selectedStatus: 'running',
			isVisible: false,
		});
		await rerender({
			selectedChatId: 'chat-append',
			selectedStatus: 'running',
			isVisible: true,
		});
		await nextAnimationFrame();

		expect(textarea.scrollTop).toBe(100);
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

	it('keeps the next draft editable but blocks sending during direct admission', async () => {
		const onsubmit = vi.fn();
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-admitting',
			selectedStatus: 'running',
			directAdmissionPending: true,
			onsubmit,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'queue this next' } });

		expect(textarea.disabled).toBe(false);
		expect(
			(screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
		).toBe(true);
		await fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(onsubmit).not.toHaveBeenCalled();

		await rerender({
			directAdmissionPending: false,
			selectedIsProcessing: true,
		});
		const queueButton = screen.getByRole('button', { name: 'Queue message' }) as HTMLButtonElement;
		expect(queueButton.disabled).toBe(false);
		await fireEvent.click(queueButton);
		expect(onsubmit).toHaveBeenCalledOnce();
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

	it('retries a visible focus request until focus actually lands', async () => {
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-focus-retry',
			focusRequestToken: 0,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await expectComposerFocus(textarea);

		const outsideButton = document.createElement('button');
		outsideButton.dataset.testid = 'outside-focus';
		document.body.append(outsideButton);
		outsideButton.focus();
		const nativeFocus = textarea.focus.bind(textarea);
		const focus = vi.spyOn(textarea, 'focus');
		focus.mockImplementationOnce(() => undefined);
		focus.mockImplementation(() => nativeFocus());

		await rerender({
			selectedChatId: 'chat-focus-retry',
			focusRequestToken: 1,
		});
		await waitFor(() => expect(document.activeElement).toBe(textarea));

		expect(focus.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it('cancels focus retries when the user starts another interaction', async () => {
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-focus-cancel',
			focusRequestToken: 0,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await expectComposerFocus(textarea);

		const outsideButton = document.createElement('button');
		outsideButton.dataset.testid = 'outside-focus';
		document.body.append(outsideButton);
		outsideButton.focus();
		const focus = vi.spyOn(textarea, 'focus').mockImplementation(() => undefined);

		await rerender({
			selectedChatId: 'chat-focus-cancel',
			focusRequestToken: 1,
		});
		await nextAnimationFrame();
		await fireEvent.pointerDown(outsideButton);
		const callsAfterCancellation = focus.mock.calls.length;
		await nextAnimationFrame();
		await nextAnimationFrame();

		expect(focus).toHaveBeenCalled();
		expect(focus).toHaveBeenCalledTimes(callsAfterCancellation);
		expect(document.activeElement).toBe(outsideButton);
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

	it('hides direct agents and direct recents in a non-direct chat when disabled', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedAgentId: 'claude',
			selectedStatus: 'running',
			selectableAgents: [
				'direct-openai-compatible',
				'direct-openai-responses-compatible',
				'direct-anthropic-compatible',
				'claude',
				'codex',
			],
			recentAgentSettings: [
				{
					agentId: 'direct-openai-compatible',
					model: 'chat-model',
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

		expect(
			document.querySelector('[data-slot="model-selector-agent-group"][data-group="direct"]'),
		).toBeNull();
		await fireEvent.click(await screen.findByRole('button', { name: 'Recents' }));
		expect(screen.queryByText('Direct (Chat Completions) · Chat Model')).toBeNull();
		expect(screen.getByRole('button', { name: 'Codex · OpenAI OAuth · GPT-5' })).toBeTruthy();
	});

	it('shows direct agents in a non-direct chat when enabled', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-1',
			selectedAgentId: 'claude',
			selectedStatus: 'running',
			allowDirectChats: true,
			selectableAgents: [
				'direct-openai-compatible',
				'direct-openai-responses-compatible',
				'direct-anthropic-compatible',
				'claude',
				'codex',
			],
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Opus/ }));

		const groupHeaders = Array.from(
			document.querySelectorAll<HTMLElement>('[data-slot="model-selector-agent-group"]'),
		);
		expect(groupHeaders.map((header) => header.textContent?.trim())).toEqual(['Direct', 'Agents']);
	});

	it('keeps existing direct chats unfiltered and follows optimistic ownership changes', async () => {
		const selectableAgents = [
			'direct-openai-compatible',
			'direct-openai-responses-compatible',
			'direct-anthropic-compatible',
			'claude',
			'codex',
		] as const;
		const view = render(PromptComposerTestHost, {
			selectedChatId: 'chat-direct',
			selectedAgentId: 'direct-openai-responses-compatible',
			selectedStatus: 'running',
			selectableAgents: [...selectableAgents],
		});

		await fireEvent.click(
			await screen.findByRole('button', {
				name: /Direct \(Responses\).*Responses Model/,
			}),
		);
		expect(
			document.querySelector('[data-slot="model-selector-agent-group"][data-group="direct"]'),
		).toBeTruthy();

		await view.rerender({
			selectedChatId: 'chat-direct',
			selectedAgentId: 'claude',
			selectedStatus: 'running',
			selectableAgents: [...selectableAgents],
		});
		await waitFor(() => {
			expect(
				document.querySelector('[data-slot="model-selector-agent-group"][data-group="direct"]'),
			).toBeNull();
		});

		await view.rerender({
			selectedChatId: 'chat-direct',
			selectedAgentId: 'direct-openai-responses-compatible',
			selectedStatus: 'running',
			selectableAgents: [...selectableAgents],
		});
		await waitFor(() => {
			expect(
				document.querySelector('[data-slot="model-selector-agent-group"][data-group="direct"]'),
			).toBeTruthy();
		});
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
				arguments: { type: 'value', value: 'the API' },
				context: { type: 'chat', chatId: 'chat-snippet-review' },
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		expect(onsubmit).toHaveBeenCalledTimes(1);
	});

	it('uses a new-chat expansion context for a local draft', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'draft expansion',
		});
		render(PromptComposerTestHost, {
			selectedChatId: '1787471053739199',
			selectedStatus: 'draft',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: '/s review' } });

		await fireEvent.keyDown(textarea, { key: 'Enter' });

		await waitFor(() => expect(textarea.value).toBe('draft expansion'));
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: { type: 'default' },
				context: {
					type: 'new-chat',
					chatId: '1787471053739199',
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('distinguishes omitted slash arguments from an explicit empty value', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValue({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'expanded',
		});
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-default',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await fireEvent.input(textarea, { target: { value: '/s review' } });
		await fireEvent.keyDown(textarea, { key: 'Enter' });
		await waitFor(() => expect(textarea.value).toBe('expanded'));
		await fireEvent.input(textarea, { target: { value: '/s review ' } });
		await fireEvent.keyDown(textarea, { key: 'Enter' });
		await waitFor(() => expect(textarea.value).toBe('expanded'));

		expect(snippetsApi.expandSnippet).toHaveBeenNthCalledWith(
			1,
			{
				shortName: 'review',
				arguments: { type: 'default' },
				context: { type: 'chat', chatId: 'chat-snippet-default' },
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(snippetsApi.expandSnippet).toHaveBeenNthCalledWith(
			2,
			{
				shortName: 'review',
				arguments: { type: 'value', value: '' },
				context: { type: 'chat', chatId: 'chat-snippet-default' },
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('keeps submission controls gated during expansion and Escape preserves the invocation', async () => {
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
		const send = screen.getByRole('button', { name: 'Send message' });
		send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(textarea);

		const pendingSend = await screen.findByRole('button', { name: 'Expanding snippet' });
		expect(textarea.readOnly).toBe(false);
		expect(textarea.getAttribute('aria-busy')).toBe('true');
		expect((pendingSend as HTMLButtonElement).disabled).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Add to prompt' }) as HTMLButtonElement).disabled,
		).toBe(true);
		const pendingEnter = new KeyboardEvent('keydown', {
			key: 'Enter',
			bubbles: true,
			cancelable: true,
		});
		textarea.dispatchEvent(pendingEnter);
		expect(pendingEnter.defaultPrevented).toBe(true);

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
			snippetDefaultArguments: 'the API',
			onsubmit,
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Before replace after' } });
		textarea.setSelectionRange(7, 14);
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		expect(argumentsInput.value).toBe('the API');
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await waitFor(() => expect(textarea.value).toBe('Before EXPANDED after'));
		expect(textarea.selectionStart).toBe('Before EXPANDED'.length);
		expect(onsubmit).not.toHaveBeenCalled();
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: { type: 'value', value: 'the API' },
				context: { type: 'chat', chatId: 'chat-snippet-insert' },
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('keeps focus and accepts user edits while a menu expansion is pending', async () => {
		const pending = deferredSnippetExpansion();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-edit-during-expansion',
			selectedStatus: 'running',
			snippetTemplate: 'Expanded review',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Original draft' } });
		textarea.focus();
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		const option = await screen.findByRole('option', { name: /^review/ });

		option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(textarea);
		await screen.findByRole('button', { name: 'Expanding snippet' });
		expect(textarea.readOnly).toBe(false);

		await fireEvent.input(textarea, { target: { value: 'User edit wins' } });
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
		expect(textarea.value).toBe('User edit wins');
	});

	it('opens from an inline trigger and replaces only the captured span', async () => {
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'EXPANDED',
		});
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-inline-snippet',
			selectedStatus: 'running',
			snippetTemplate: 'Expanded review',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		const source = 'Before ;;review after';
		const triggerEnd = 'Before ;;review'.length;

		await inputAtCaret(textarea, source, triggerEnd);
		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		expect(search.value).toBe('review');
		await fireEvent.click(screen.getByRole('option', { name: /^review\b/ }));

		await waitFor(() => expect(textarea.value).toBe('Before EXPANDED after'));
		expect(textarea.selectionStart).toBe('Before EXPANDED'.length);
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: { type: 'value', value: '' },
				context: { type: 'chat', chatId: 'chat-inline-snippet' },
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('honors the configured trigger without interrupting IME composition', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-custom-snippet-trigger',
			selectedStatus: 'running',
			snippetTrigger: '!!',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		await inputAtCaret(textarea, ';;', 2);
		expect(screen.queryByRole('dialog', { name: 'Insert Snippet' })).toBeNull();

		await inputAtCaret(textarea, '!!', 2, { isComposing: true });
		expect(screen.queryByRole('dialog', { name: 'Insert Snippet' })).toBeNull();

		await inputAtCaret(textarea, '!!', 2);
		expect(await screen.findByRole('dialog', { name: 'Insert Snippet' })).toBeTruthy();
	});

	it('suppresses a dismissed trigger until that occurrence is removed', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-dismissed-snippet-trigger',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await inputAtCaret(textarea, ';;', 2);

		await fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Insert Snippet' }), {
			key: 'Escape',
		});
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Insert Snippet' })).toBeNull(),
		);
		expect(textarea.value).toBe(';;');

		await inputAtCaret(textarea, ';;r', 3);
		expect(screen.queryByRole('dialog', { name: 'Insert Snippet' })).toBeNull();
		await inputAtCaret(textarea, ';;review ', 9);
		await inputAtCaret(textarea, ';;review', 8);
		await inputAtCaret(textarea, ';;', 2);
		expect(screen.queryByRole('dialog', { name: 'Insert Snippet' })).toBeNull();

		await inputAtCaret(textarea, ';', 1);
		await inputAtCaret(textarea, ';;', 2);
		expect(await screen.findByRole('dialog', { name: 'Insert Snippet' })).toBeTruthy();
	});

	it('clears inline-trigger dismissal when the selected chat changes', async () => {
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-dismissal-one',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await inputAtCaret(textarea, ';;', 2);
		await fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Insert Snippet' }), {
			key: 'Escape',
		});
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Insert Snippet' })).toBeNull(),
		);

		await rerender({
			selectedChatId: 'chat-dismissal-two',
			selectedStatus: 'running',
		});
		await inputAtCaret(textarea, ';;', 2);

		expect(await screen.findByRole('dialog', { name: 'Insert Snippet' })).toBeTruthy();
	});

	it('dismisses the inline chain when argument entry is cancelled', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-inline-arguments-cancel',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await inputAtCaret(textarea, ';;review', 8);
		await fireEvent.click(await screen.findByRole('option', { name: /^review\b/ }));

		const argumentsDialog = await screen.findByRole('dialog', {
			name: 'Arguments for /snippet review',
		});
		await fireEvent.keyDown(argumentsDialog, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Arguments for /snippet review' })).toBeNull(),
		);

		await inputAtCaret(textarea, ';;reviewx', 9);
		expect(screen.queryByRole('dialog', { name: 'Insert Snippet' })).toBeNull();
	});

	it('retries failed inline arguments against the original trigger span', async () => {
		vi.mocked(snippetsApi.expandSnippet)
			.mockRejectedValueOnce(new Error('server unavailable'))
			.mockResolvedValueOnce({
				success: true,
				snippetId: 'snippet-review',
				snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
				shortName: 'review',
				contextProjectPath: '/workspace/project',
				expandedText: 'EXPANDED',
			});
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-inline-snippet-retry',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		const source = 'Before ;;review after';
		await inputAtCaret(textarea, source, 'Before ;;review'.length);
		await fireEvent.click(await screen.findByRole('option', { name: /^review\b/ }));
		await fireEvent.input(await screen.findByRole('textbox', { name: 'Arguments' }), {
			target: { value: 'the API' },
		});
		await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Arguments' }), {
			key: 'Enter',
		});

		await screen.findByText('Snippet expansion failed: server unavailable');
		const retryInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.keyDown(retryInput, { key: 'Enter' });

		await waitFor(() => expect(textarea.value).toBe('Before EXPANDED after'));
		expect(snippetsApi.expandSnippet).toHaveBeenCalledTimes(2);
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
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
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
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
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
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
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

	it('explains and blocks palette insertion when the chat has no project path', async () => {
		render(PromptComposerTestHost, {
			selectedChatId: 'chat-snippet-menu-missing-path',
			selectedStatus: 'running',
			projectPath: '   ',
		});
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await screen.findByText('Set a project path to insert snippets');
		const option = screen.getByRole('option', { name: /^review/ });
		expect(option.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(option);

		expect(screen.getByRole('dialog', { name: 'Insert Snippet' })).toBeTruthy();
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
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
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
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
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
