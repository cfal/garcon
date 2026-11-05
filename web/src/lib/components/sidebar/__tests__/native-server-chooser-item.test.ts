import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import Host from './NativeServerChooserItemHost.svelte';

afterEach(() => {
	cleanup();
	delete window.__GARCON_NATIVE__;
});

it('omits the native action in browsers', async () => {
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	expect(screen.queryByText('Open Server')).toBeNull();
});

it('requests the chooser without navigating or logging out', async () => {
	const requestServerChooser = vi.fn();
	window.__GARCON_NATIVE__ = { version: 1, requestServerChooser };
	render(Host);
	await fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
	await fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Server' }));
	expect(requestServerChooser).toHaveBeenCalledTimes(1);
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
	await fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Server' }));
	expect(await screen.findByRole('menuitem', { name: 'Open Server unavailable' })).toBeTruthy();
});
