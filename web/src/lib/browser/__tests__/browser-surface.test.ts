import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSurfaceController } from '../browser-surface.svelte';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

const APP_ORIGIN = 'https://garcon.example.com';

function createController(
	options: ConstructorParameters<typeof BrowserSurfaceController>[0] = {},
): BrowserSurfaceController {
	return new BrowserSurfaceController({ appOrigin: APP_ORIGIN, embedProbe: null, ...options });
}

describe('BrowserSurfaceController', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('starts empty and rejects invalid input without committing', () => {
		const controller = createController();
		expect(controller.committedUrl).toBeNull();

		expect(controller.navigate('javascript:alert(1)')).toBe(false);
		expect(controller.rejection).toBe('scheme');
		expect(controller.committedUrl).toBeNull();
		expect(controller.frameGeneration).toBe(0);
	});

	it('commits normalized URLs, syncs the address input, and persists', () => {
		const controller = createController();

		expect(controller.navigate('localhost:5173')).toBe(true);
		expect(controller.committedUrl).toBe('http://localhost:5173/');
		expect(controller.inputValue).toBe('http://localhost:5173/');
		expect(controller.rejection).toBeNull();
		expect(controller.frameGeneration).toBe(1);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.browserSurface) ?? '')).toEqual({
			url: 'http://localhost:5173/',
		});
	});

	it('keeps the committed page when later input is rejected', () => {
		const controller = createController();
		controller.navigate('https://example.com');

		expect(controller.navigate('https://garcon.example.com/steal')).toBe(false);
		expect(controller.rejection).toBe('same-origin');
		expect(controller.committedUrl).toBe('https://example.com/');
	});

	it('reloads by remounting without touching history stacks', () => {
		const controller = createController();
		controller.navigate('https://example.com');
		const generation = controller.frameGeneration;

		controller.reload();
		expect(controller.frameGeneration).toBe(generation + 1);
		expect(controller.committedUrl).toBe('https://example.com/');
		expect(controller.canGoBack).toBe(false);
		expect(controller.canGoForward).toBe(false);
	});

	it('treats navigating to the committed URL as a reload without a stack push', () => {
		const controller = createController();
		controller.navigate('https://example.com');

		controller.navigate('https://example.com');
		expect(controller.canGoBack).toBe(false);
		expect(controller.frameGeneration).toBe(2);
	});

	it('steps back and forward over committed URLs', () => {
		const controller = createController();
		controller.navigate('https://one.example.com');
		controller.navigate('https://two.example.com');
		controller.navigate('https://three.example.com');
		expect(controller.canGoBack).toBe(true);
		expect(controller.canGoForward).toBe(false);

		controller.goBack();
		expect(controller.committedUrl).toBe('https://two.example.com/');
		expect(controller.canGoForward).toBe(true);

		controller.goBack();
		expect(controller.committedUrl).toBe('https://one.example.com/');
		expect(controller.canGoBack).toBe(false);

		controller.goForward();
		expect(controller.committedUrl).toBe('https://two.example.com/');
		expect(controller.canGoBack).toBe(true);
		expect(controller.canGoForward).toBe(true);
	});

	it('clears the forward stack on new navigation', () => {
		const controller = createController();
		controller.navigate('https://one.example.com');
		controller.navigate('https://two.example.com');
		controller.goBack();

		controller.navigate('https://three.example.com');
		expect(controller.canGoForward).toBe(false);
		controller.goBack();
		expect(controller.committedUrl).toBe('https://one.example.com/');
	});

	it('restores the persisted URL and re-validates it', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.browserSurface,
			JSON.stringify({ url: 'https://example.com/docs' }),
		);
		const restored = createController();
		expect(restored.committedUrl).toBe('https://example.com/docs');
		expect(restored.inputValue).toBe('https://example.com/docs');
	});

	it('normalizes an unnormalized persisted URL instead of using it raw', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.browserSurface,
			JSON.stringify({ url: 'example.com' }),
		);
		// A raw value would become a relative iframe src resolving to the app.
		expect(createController().committedUrl).toBe('https://example.com/');
	});

	it('probes the restored URL so the refusal banner survives a reload', async () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.browserSurface,
			JSON.stringify({ url: 'https://example.com/docs' }),
		);
		const probe = vi.fn(async () => 'blocked' as const);
		const restored = createController({ embedProbe: probe });

		await vi.waitFor(() => expect(probe).toHaveBeenCalledWith('https://example.com/docs'));
		await vi.waitFor(() => expect(restored.embedVerdict).toBe('blocked'));
	});

	it('clears stale persistence when a URL is too long to store', () => {
		const controller = createController();
		controller.navigate('https://example.com/short');
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.browserSurface)).not.toBeNull();

		controller.navigate(`https://example.com/${'a'.repeat(9000)}`);

		// Keeping the old entry would restore an older page than the one shown.
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.browserSurface)).toBeNull();
	});

	it('skips probing URLs the server would reject as too long', () => {
		const probe = vi.fn(async () => 'blocked' as const);
		const controller = createController({ embedProbe: probe });

		controller.navigate(`https://example.com/${'a'.repeat(5000)}`);

		expect(probe).not.toHaveBeenCalled();
		expect(controller.embedVerdict).toBeNull();
	});

	it('ignores poisoned or malformed persisted state', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.browserSurface,
			JSON.stringify({ url: 'javascript:alert(1)' }),
		);
		expect(createController().committedUrl).toBeNull();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.browserSurface,
			JSON.stringify({ url: `${APP_ORIGIN}/chat` }),
		);
		expect(createController().committedUrl).toBeNull();

		localStorage.setItem(LOCAL_STORAGE_KEYS.browserSurface, 'not json');
		expect(createController().committedUrl).toBeNull();
	});

	it('probes only the latest of several same-tick navigations', async () => {
		const probe = vi.fn(async () => 'embeddable' as const);
		const controller = createController({ embedProbe: probe });

		controller.navigate('https://one.example.com');
		controller.navigate('https://two.example.com');

		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
		expect(probe).toHaveBeenCalledWith('https://two.example.com/');
		await vi.waitFor(() => expect(controller.embedVerdict).toBe('embeddable'));
	});

	it('drops a slow verdict once a newer navigation has superseded it', async () => {
		const resolvers: Array<(verdict: 'blocked' | 'embeddable') => void> = [];
		const probe = vi.fn(
			() =>
				new Promise<'blocked' | 'embeddable'>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const controller = createController({ embedProbe: probe });

		controller.navigate('https://one.example.com');
		await vi.waitFor(() => expect(resolvers).toHaveLength(1));
		controller.navigate('https://two.example.com');
		await vi.waitFor(() => expect(resolvers).toHaveLength(2));

		resolvers[0]('blocked');
		await Promise.resolve();
		expect(controller.embedVerdict).toBeNull();

		resolvers[1]('embeddable');
		await vi.waitFor(() => expect(controller.embedVerdict).toBe('embeddable'));
	});

	// An unprobed URL must still invalidate an in-flight probe, or the previous
	// page's verdict would be shown for the current one.
	it('does not apply a pending verdict after navigating to an unprobed URL', async () => {
		const resolvers: Array<(verdict: 'blocked') => void> = [];
		const probe = vi.fn(
			() =>
				new Promise<'blocked'>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const controller = createController({ embedProbe: probe });

		controller.navigate('https://one.example.com');
		await vi.waitFor(() => expect(resolvers).toHaveLength(1));
		controller.navigate(`https://example.com/${'a'.repeat(5000)}`);

		resolvers[0]('blocked');
		await Promise.resolve();
		expect(controller.embedVerdict).toBeNull();
	});

	it('clears the verdict on each commit and survives probe failures', async () => {
		let shouldFail = false;
		const probe = vi.fn(async () => {
			if (shouldFail) throw new Error('offline');
			return 'blocked' as const;
		});
		const controller = createController({ embedProbe: probe });

		controller.navigate('https://one.example.com');
		await vi.waitFor(() => expect(controller.embedVerdict).toBe('blocked'));

		shouldFail = true;
		controller.navigate('https://two.example.com');
		expect(controller.embedVerdict).toBeNull();
		await Promise.resolve();
		expect(controller.embedVerdict).toBeNull();
	});

	it('keeps the persisted URL on dispose so reopening restores it', () => {
		const controller = createController();
		controller.navigate('https://example.com');
		controller.dispose();
		expect(createController().committedUrl).toBe('https://example.com/');
	});
});
