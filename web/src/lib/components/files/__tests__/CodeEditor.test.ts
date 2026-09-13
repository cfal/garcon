import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import CodeEditorFocusTestHost from './CodeEditorFocusTestHost.svelte';

describe('CodeEditor', () => {
	it.each(['Escape', 'r', 'd'])('leaves Vim %s events for the editor plugin', async (key) => {
		const registration: { handler: ((event: KeyboardEvent) => boolean) | null } = { handler: null };
		render(CodeEditorFocusTestHost, {
			vimOwnsKey: () => true,
			onRegisterShortcut: (handler) => (registration.handler = handler),
		});
		await waitFor(() => expect(registration.handler).not.toBeNull());
		const event = new KeyboardEvent('keydown', {
			key,
			ctrlKey: key !== 'Escape',
			cancelable: true,
		});
		const stop = vi.spyOn(event, 'stopPropagation');
		expect(registration.handler?.(event)).toBe(true);
		expect(event.defaultPrevented).toBe(false);
		expect(stop).not.toHaveBeenCalled();
	});
	it('leaves unowned shortcuts and composing events untouched', async () => {
		const registration: { handler: ((event: KeyboardEvent) => boolean) | null } = { handler: null };
		const vimOwnsKey = vi.fn(() => false);
		const closeDialog = vi.fn(() => false);
		const closeSearch = vi.fn(() => false);
		render(CodeEditorFocusTestHost, {
			vimOwnsKey,
			closeDialog,
			closeSearch,
			onRegisterShortcut: (handler) => (registration.handler = handler),
		});
		await waitFor(() => expect(registration.handler).not.toBeNull());
		const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true });
		expect(registration.handler?.(event)).toBe(false);
		expect(event.defaultPrevented).toBe(false);
		expect(vimOwnsKey).toHaveBeenCalledOnce();

		const composing = new KeyboardEvent('keydown', {
			key: 'r',
			ctrlKey: true,
			isComposing: true,
			cancelable: true,
		});
		expect(registration.handler?.(composing)).toBe(false);
		expect(composing.defaultPrevented).toBe(false);
		expect(vimOwnsKey).toHaveBeenCalledOnce();
		expect(closeDialog).not.toHaveBeenCalled();
		expect(closeSearch).not.toHaveBeenCalled();
	});

	it('releases Escape focus to the owning workbench surface', async () => {
		const registration: { handler: ((event: KeyboardEvent) => boolean) | null } = {
			handler: null,
		};
		const rendered = render(CodeEditorFocusTestHost, {
			onRegisterShortcut: (handler) => (registration.handler = handler),
		});
		await waitFor(() => expect(registration.handler).not.toBeNull());
		const registeredHandler = registration.handler;
		if (!registeredHandler) throw new Error('Expected shortcut handler');
		const content = rendered.container.querySelector<HTMLElement>('.h-full');
		const surface = rendered.container.querySelector<HTMLElement>('[data-workspace-surface-id]');
		if (!content || !surface) throw new Error('Expected editor surface');
		content.tabIndex = 0;
		content.focus();

		expect(registeredHandler(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
		expect(document.activeElement).toBe(surface);
	});

	it('consumes Escape when closing Find before the dialog can handle it', async () => {
		const registration: { handler: ((event: KeyboardEvent) => boolean) | null } = {
			handler: null,
		};
		render(CodeEditorFocusTestHost, {
			closeSearch: () => true,
			onRegisterShortcut: (handler) => (registration.handler = handler),
		});
		await waitFor(() => expect(registration.handler).not.toBeNull());
		const event = new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
		});
		const stopPropagation = vi.spyOn(event, 'stopPropagation');
		const stopImmediatePropagation = vi.spyOn(event, 'stopImmediatePropagation');

		expect(registration.handler?.(event)).toBe(true);
		expect(event.defaultPrevented).toBe(true);
		expect(stopPropagation).toHaveBeenCalledOnce();
		expect(stopImmediatePropagation).toHaveBeenCalledOnce();
	});

	it('dismisses an editor dialog before Find or the workbench focus fallback', async () => {
		const registration: { handler: ((event: KeyboardEvent) => boolean) | null } = {
			handler: null,
		};
		const closeDialog = vi.fn(() => true);
		const closeSearch = vi.fn(() => true);
		const onFocus = vi.fn();
		render(CodeEditorFocusTestHost, {
			closeDialog,
			closeSearch,
			onFocus,
			onRegisterShortcut: (handler) => (registration.handler = handler),
		});
		await waitFor(() => expect(registration.handler).not.toBeNull());
		const composingEscape = new KeyboardEvent('keydown', {
			key: 'Escape',
			cancelable: true,
			isComposing: true,
		});
		expect(registration.handler?.(composingEscape)).toBe(false);
		expect(composingEscape.defaultPrevented).toBe(false);
		expect(closeDialog).not.toHaveBeenCalled();
		expect(closeSearch).not.toHaveBeenCalled();

		expect(registration.handler?.(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
		expect(closeDialog).toHaveBeenCalledOnce();
		expect(closeSearch).not.toHaveBeenCalled();
		expect(onFocus).not.toHaveBeenCalled();
	});

	it('delegates primary focus to the editor controller', async () => {
		const onFocus = vi.fn();
		const { rerender } = render(CodeEditorFocusTestHost, {
			focusRequestToken: 0,
			onFocus,
		});

		await rerender({ focusRequestToken: 1, onFocus });

		await waitFor(() => expect(onFocus).toHaveBeenCalledOnce());
	});
});
