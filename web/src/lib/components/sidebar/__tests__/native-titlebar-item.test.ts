import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { NativeTitlebar, NativeTitlebarSnapshot } from '$lib/native/titlebar';
import Host from './NativeServerChooserItemHost.svelte';

afterEach(() => {
	cleanup();
	delete window.__GARCON_NATIVE__;
});

function installTitlebar(hidden = false) {
	let snapshot: NativeTitlebarSnapshot = { hidden, failed: false };
	const listeners = new Set<(value: NativeTitlebarSnapshot) => void>();
	const publish = (value: NativeTitlebarSnapshot) => {
		snapshot = value;
		for (const listener of listeners) listener(value);
	};
	const requestHidden = vi.fn((hidden: boolean) => publish({ hidden, failed: false }));
	const titlebar = {
		requestHidden,
		subscribe(listener) {
			listener(snapshot);
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	} satisfies NativeTitlebar;
	window.__GARCON_NATIVE__ = { version: 1, requestServerChooser: vi.fn(), titlebar };
	return { requestHidden, publish, listeners };
}

it('uses the shared checkbox under Open Server and restores hidden controls', async () => {
	const native = installTitlebar();
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	const item = await screen.findByRole('menuitemcheckbox', { name: 'Hide titlebar' });
	expect(item.dataset.slot).toBe('dropdown-menu-checkbox-item');
	expect(item.previousElementSibling).toBe(screen.getByRole('menuitem', { name: 'Open Server' }));
	expect(item.getAttribute('aria-checked')).toBe('false');
	await fireEvent.click(item);
	expect(native.requestHidden).toHaveBeenLastCalledWith(true);
	const checked = await screen.findByRole('menuitemcheckbox', { name: 'Hide titlebar' });
	expect(checked.getAttribute('aria-checked')).toBe('true');
	await fireEvent.click(checked);
	expect(native.requestHidden).toHaveBeenLastCalledWith(false);
});

it('reads host state on mount and unsubscribes when the menu unmounts', async () => {
	const native = installTitlebar(true);
	const view = render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	expect(
		(await screen.findByRole('menuitemcheckbox', { name: 'Hide titlebar' })).getAttribute(
			'aria-checked',
		),
	).toBe('true');
	expect(native.listeners.size).toBe(1);
	await view.unmount();
	expect(native.listeners.size).toBe(0);
});

it('reflects native failures without treating a rejected change as success', async () => {
	const native = installTitlebar();
	native.requestHidden.mockImplementation(() => native.publish({ hidden: false, failed: true }));
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	await fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Hide titlebar' }));
	const failed = await screen.findByRole('menuitemcheckbox', { name: 'Titlebar unavailable' });
	expect(failed.getAttribute('aria-checked')).toBe('false');
	native.publish({ hidden: true, failed: false });
	await waitFor(() =>
		expect(
			screen.getByRole('menuitemcheckbox', { name: 'Hide titlebar' }).getAttribute('aria-checked'),
		).toBe('true'),
	);
});

it('keeps synchronous bridge failures retryable', async () => {
	const native = installTitlebar();
	native.requestHidden.mockImplementation(() => {
		throw new Error('Unavailable');
	});
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	await fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Hide titlebar' }));
	expect(
		(await screen.findByRole('menuitemcheckbox', { name: 'Titlebar unavailable' })).getAttribute(
			'aria-checked',
		),
	).toBe('false');
});
