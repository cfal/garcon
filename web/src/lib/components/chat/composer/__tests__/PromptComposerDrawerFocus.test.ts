import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';

const chatId = 'synthetic-destination';

async function mount() {
	const view = render(PromptComposerTestHost, { selectedChatId: chatId });
	const input = screen.getByRole<HTMLTextAreaElement>('textbox');
	await waitFor(() => expect(document.activeElement).toBe(input));
	const outside = screen.getByTestId('append-draft');
	outside.focus();
	const { appShell, transientLayers } = view.component.getFocusServices();
	const request = (owner = chatId) => flushSync(() =>
		appShell.requestComposerFocus({ chatId: owner, userInteractionGeneration: 0 }));
	vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
	return { input, outside, request, appShell, transientLayers, rerender: view.rerender };
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('focuses the committed drawer destination before a held frame, without a second attempt', async () => {
	const { input, request } = await mount();
	const focus = vi.spyOn(input, 'focus');
	request();
	expect(document.activeElement).toBe(input);
	expect(focus).toHaveBeenCalledTimes(1);
	vi.advanceTimersToNextFrame();
	expect(focus).toHaveBeenCalledTimes(1);
});

it('uses the original frame retry after a real refusal, once', async () => {
	const { input, outside, request } = await mount();
	const focus = vi.spyOn(input, 'focus').mockImplementationOnce(() => {});
	request();
	expect(focus).toHaveBeenCalledTimes(1);
	expect(document.activeElement).toBe(outside);
	vi.advanceTimersToNextFrame();
	expect(document.activeElement).toBe(input);
	vi.advanceTimersToNextFrame();
	expect(focus).toHaveBeenCalledTimes(2);
});

it('does not transfer stale drawer selection or focus over a later interaction', async () => {
	const { input, outside, request } = await mount();
	const focus = vi.spyOn(input, 'focus');
	request('another-owner');
	await fireEvent.pointerDown(outside);
	request();
	vi.advanceTimersToNextFrame();
	expect(focus).not.toHaveBeenCalled();
	expect(document.activeElement).toBe(outside);
});

it('drops a refused retry when the drawer reopens or a newer modal owns focus', async () => {
	const { input, outside, request, appShell, transientLayers } = await mount();
	const focus = vi.spyOn(input, 'focus').mockImplementationOnce(() => {});
	request();
	flushSync(() => appShell.setSidebarOpen(true));
	vi.advanceTimersToNextFrame();
	flushSync(() => appShell.setSidebarOpen(false));
	const release = transientLayers.register({
		id: 'synthetic-modal', kind: 'application-dialog', modality: 'main-inert',
		isOpen: () => true, element: () => outside, onEscape: () => false, restoreFocus: () => {},
	});
	request();
	flushSync(release);
	vi.advanceTimersToNextFrame();
	expect(focus).toHaveBeenCalledTimes(1);
	expect(document.activeElement).toBe(outside);
});

it('keeps a disabled or hidden destination pending; an ordinary newer request still waits a frame', async () => {
	const { input, outside, request, appShell, rerender } = await mount();
	const focus = vi.spyOn(input, 'focus');
	await rerender({ selectedStatus: 'draft', directAdmissionPending: true });
	request();
	expect(input.disabled).toBe(true);
	vi.advanceTimersToNextFrame();
	expect(focus).not.toHaveBeenCalled();
	await rerender({ directAdmissionPending: false, isVisible: false });
	vi.advanceTimersToNextFrame();
	expect(focus).not.toHaveBeenCalled();
	flushSync(() => appShell.requestComposerFocus());
	await rerender({ isVisible: true });
	expect(document.activeElement).toBe(outside);
	vi.advanceTimersToNextFrame();
	expect(document.activeElement).toBe(input);
	expect(focus).toHaveBeenCalledTimes(1);
});
