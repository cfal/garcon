// Committed URLs use RFC 5737 TEST-NET addresses: happy-dom really fetches
// iframe documents, and unroutable targets keep tests offline-deterministic.
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import BrowserSurface from '../BrowserSurface.svelte';
import {
	BROWSER_IFRAME_SANDBOX,
	BrowserSurfaceController,
	type EmbedProbe,
} from '$lib/browser/browser-surface.svelte';

const APP_ORIGIN = 'https://garcon.example.com';

function createController(embedProbe: EmbedProbe | null = null): BrowserSurfaceController {
	localStorage.clear();
	return new BrowserSurfaceController({ appOrigin: APP_ORIGIN, embedProbe });
}

async function typeAddressAndSubmit(value: string): Promise<void> {
	const input = screen.getByRole('textbox', { name: 'Address' });
	await fireEvent.input(input, { target: { value } });
	await fireEvent.submit(input.closest('form') as HTMLFormElement);
}

describe('BrowserSurface', () => {
	it('shows the empty state without an iframe', () => {
		const { container } = render(BrowserSurface, { controller: createController() });

		expect(screen.getByText('Open a page')).toBeTruthy();
		expect(container.querySelector('iframe')).toBeNull();
	});

	it('commits the address bar into a sandboxed iframe', async () => {
		const { container } = render(BrowserSurface, { controller: createController() });

		await typeAddressAndSubmit('192.0.2.1');

		const iframe = container.querySelector('iframe');
		expect(iframe).not.toBeNull();
		expect(iframe?.getAttribute('src')).toBe('https://192.0.2.1/');
		expect(iframe?.getAttribute('sandbox')).toBe(BROWSER_IFRAME_SANDBOX);
		expect(iframe?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
		// An escaped popup would be unsandboxed and could navigate opener.top.
		expect(iframe?.getAttribute('sandbox')).not.toContain('allow-popups-to-escape-sandbox');
		expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
		expect(iframe?.getAttribute('allow')).toBe('fullscreen');
		expect(iframe?.getAttribute('title')).toBe('Embedded browser content');
	});

	it('shows a rejection banner for refused URLs and keeps prior content', async () => {
		const { container } = render(BrowserSurface, { controller: createController() });
		await typeAddressAndSubmit('192.0.2.1');

		await typeAddressAndSubmit(`${APP_ORIGIN}/chat`);

		const alert = screen.getByRole('alert');
		expect(alert.textContent).toContain("Garcon can't embed its own pages.");
		expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://192.0.2.1/');
	});

	it('warns about mixed content instead of showing a blank frame silently', async () => {
		render(BrowserSurface, { controller: createController() });

		await typeAddressAndSubmit('http://192.0.2.20:3000');

		expect(screen.getByRole('alert').textContent).toContain("This http page can't load");
	});

	it('renders the open-externally escape hatch for the committed URL', async () => {
		render(BrowserSurface, { controller: createController() });
		await typeAddressAndSubmit('192.0.2.1');

		const external = screen.getByRole('link', { name: 'Open in new tab' });
		expect(external.getAttribute('href')).toBe('https://192.0.2.1/');
		expect(external.getAttribute('target')).toBe('_blank');
		expect(external.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('remounts the iframe on reload so no history entry is added', async () => {
		const controller = createController();
		const { container } = render(BrowserSurface, { controller });
		await typeAddressAndSubmit('192.0.2.1');
		const before = container.querySelector('iframe');

		await fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
		await tick();

		const after = container.querySelector('iframe');
		expect(after).not.toBeNull();
		expect(after).not.toBe(before);
		expect(after?.getAttribute('src')).toBe('https://192.0.2.1/');
	});

	it('disables back and forward until committed history exists', async () => {
		render(BrowserSurface, { controller: createController() });
		// Distinct from the mobile frame chrome's "Back", which exits the surface.
		const back = screen.getByRole('button', { name: 'Previous page' });
		const forward = screen.getByRole('button', { name: 'Next page' });
		expect((back as HTMLButtonElement).disabled).toBe(true);
		expect((forward as HTMLButtonElement).disabled).toBe(true);

		await typeAddressAndSubmit('192.0.2.2');
		await typeAddressAndSubmit('192.0.2.3');
		expect((back as HTMLButtonElement).disabled).toBe(false);

		await fireEvent.click(back);
		expect((forward as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByRole('textbox', { name: 'Address' })).toHaveProperty(
			'value',
			'https://192.0.2.2/',
		);
	});

	it('surfaces a blocked embed verdict as a banner', async () => {
		const controller = createController(async () => 'blocked');
		render(BrowserSurface, { controller });

		await typeAddressAndSubmit('192.0.2.4');

		await waitFor(() => {
			expect(screen.getByRole('status').textContent).toContain(
				'This site refuses to be embedded.',
			);
		});
	});
});
