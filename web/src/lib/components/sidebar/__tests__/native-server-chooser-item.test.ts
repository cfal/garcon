import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import Host from './NativeServerChooserItemHost.svelte';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	delete window.__GARCON_NATIVE__;
});

it('omits the native action in browsers', async () => {
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	expect(screen.queryByText('Open server')).toBeNull();
	expect(screen.queryByText('Reload')).toBeNull();
	expect(screen.queryByRole('separator')).toBeNull();
	expect(screen.queryByRole('menuitemcheckbox', { name: 'Hide titlebar' })).toBeNull();
});

it('requests the chooser without navigating or logging out', async () => {
	const requestServerChooser = vi.fn();
	window.__GARCON_NATIVE__ = { version: 1, requestServerChooser };
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	const open = await screen.findByRole('menuitem', { name: 'Open server' });
	const separator = screen.getByRole('separator');
	const reload = screen.getByRole('menuitem', { name: 'Reload' });
	expect(reload.previousElementSibling).toBe(separator);
	expect(open.previousElementSibling).toBe(reload);
	expect(separator.previousElementSibling).toBe(screen.getByRole('menuitem', { name: 'Settings' }));
	expect(screen.queryByRole('menuitemcheckbox', { name: 'Hide titlebar' })).toBeNull();
	await fireEvent.click(open);
	expect(requestServerChooser).toHaveBeenCalledTimes(1);
});

it('reloads the current page immediately without opening the chooser or confirming', async () => {
	const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
	const confirm = vi.fn();
	vi.stubGlobal('confirm', confirm);
	const requestServerChooser = vi.fn();
	window.__GARCON_NATIVE__ = { version: 1, requestServerChooser };
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	await fireEvent.click(await screen.findByRole('menuitem', { name: 'Reload' }));
	expect(reload).toHaveBeenCalledTimes(1);
	expect(confirm).not.toHaveBeenCalled();
	expect(requestServerChooser).not.toHaveBeenCalled();
});

it('keeps a failed request retryable', async () => {
	window.__GARCON_NATIVE__ = {
		version: 1,
		requestServerChooser() {
			throw new Error('Unavailable');
		},
	};
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	await fireEvent.click(await screen.findByRole('menuitem', { name: 'Open server' }));
	expect(await screen.findByRole('menuitem', { name: 'Open server unavailable' })).toBeTruthy();
});

it('uses managed native reload without a confirmation or ordinary browser reload', async () => {
	const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
	const confirm = vi.fn();
	vi.stubGlobal('confirm', confirm);
	const requestReload = vi.fn();
	const requestServerChooser = vi.fn();
	window.__GARCON_NATIVE__ = {
		version: 1, requestServerChooser,
		lifecycle: { requestReload, reportReady: vi.fn() },
	};
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	await fireEvent.click(await screen.findByRole('menuitem', { name: 'Reload' }));
	expect(requestReload).toHaveBeenCalledExactlyOnceWith();
	expect(reload).not.toHaveBeenCalled();
	expect(confirm).not.toHaveBeenCalled();
	expect(requestServerChooser).not.toHaveBeenCalled();
});
