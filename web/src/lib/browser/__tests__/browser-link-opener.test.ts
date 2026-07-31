import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserLinkOpener, type BrowserLinkOpenerDeps } from '../browser-link-opener';
import { BrowserSurfaceController } from '../browser-surface.svelte';

const APP_ORIGIN = 'https://garcon.example.com';

function createDeps(overrides?: {
	openLinksInBrowserSurface?: boolean;
	isMobile?: boolean;
	workspacePresented?: boolean;
}): {
	deps: BrowserLinkOpenerDeps;
	controller: BrowserSurfaceController;
	openSingleton: ReturnType<typeof vi.fn>;
	focusMobileSingleton: ReturnType<typeof vi.fn>;
} {
	const controller = new BrowserSurfaceController({ appOrigin: APP_ORIGIN, embedProbe: null });
	const openSingleton = vi.fn(async () => {});
	const focusMobileSingleton = vi.fn(async () => {});
	const deps: BrowserLinkOpenerDeps = {
		settings: { openLinksInBrowserSurface: overrides?.openLinksInBrowserSurface ?? true },
		workspace: {
			isMobile: overrides?.isMobile ?? false,
			openSingleton,
			focusMobileSingleton,
		},
		surfaces: { browser: () => controller },
		workspacePresented: overrides?.workspacePresented ?? true,
	};
	return { deps, controller, openSingleton, focusMobileSingleton };
}

describe('BrowserLinkOpener', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('declines when the setting is off', () => {
		const { deps, openSingleton } = createDeps({ openLinksInBrowserSurface: false });

		expect(new BrowserLinkOpener(deps).openExternalLink('https://example.com')).toBe(false);
		expect(openSingleton).not.toHaveBeenCalled();
	});

	// Public routes such as /shared/:token render markdown without workspace
	// chrome; capturing there would swallow the click into an invisible surface.
	it('declines when the workspace is not presented, even with the setting on', () => {
		const { deps, controller, openSingleton, focusMobileSingleton } = createDeps({
			workspacePresented: false,
		});

		expect(new BrowserLinkOpener(deps).openExternalLink('https://example.com')).toBe(false);
		expect(controller.committedUrl).toBeNull();
		expect(openSingleton).not.toHaveBeenCalled();
		expect(focusMobileSingleton).not.toHaveBeenCalled();
		expect(localStorage.getItem('browser_surface_v1')).toBeNull();
	});

	it('declines non-embeddable URLs so the anchor keeps default behavior', () => {
		const { deps, controller, openSingleton } = createDeps();
		const opener = new BrowserLinkOpener(deps);

		expect(opener.openExternalLink('mailto:someone@example.com')).toBe(false);
		expect(opener.openExternalLink(`${APP_ORIGIN}/chat`)).toBe(false);
		expect(controller.committedUrl).toBeNull();
		expect(openSingleton).not.toHaveBeenCalled();
	});

	it('navigates the controller and opens the surface in the sidebar', () => {
		const { deps, controller, openSingleton, focusMobileSingleton } = createDeps();

		expect(new BrowserLinkOpener(deps).openExternalLink('https://example.com/docs')).toBe(true);
		expect(controller.committedUrl).toBe('https://example.com/docs');
		expect(openSingleton).toHaveBeenCalledWith('browser', 'sidebar');
		expect(focusMobileSingleton).not.toHaveBeenCalled();
	});

	it('focuses the mobile singleton on mobile', () => {
		const { deps, openSingleton, focusMobileSingleton } = createDeps({ isMobile: true });

		expect(new BrowserLinkOpener(deps).openExternalLink('https://example.com')).toBe(true);
		expect(focusMobileSingleton).toHaveBeenCalledWith('browser');
		expect(openSingleton).not.toHaveBeenCalled();
	});
});
