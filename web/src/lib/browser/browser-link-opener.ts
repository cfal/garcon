// Routes captured links into the Browser surface when the local setting is
// on. Any rejection falls back to default new-tab navigation, so capture can
// never break a link.

import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
import type { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte';
import { normalizeBrowserUrl } from './browser-url.js';
import type { ExternalLinkPolicy } from './external-link-policy.js';

export interface BrowserLinkOpenerDeps {
	readonly settings: Pick<LocalSettingsStore, 'openLinksInBrowserSurface'>;
	readonly workspace: Pick<
		WorkspaceCoordinator,
		'isMobile' | 'openSingleton' | 'focusMobileSingleton'
	>;
	readonly surfaces: Pick<SingletonSurfaceRegistry, 'browser'>;
	/**
	 * Whether the workspace chrome is on screen. Public routes such as the
	 * shared-transcript page render markdown without it, and capturing there
	 * would swallow the click into a surface the user cannot see.
	 */
	readonly workspacePresented: boolean;
}

export class BrowserLinkOpener implements ExternalLinkPolicy {
	constructor(private readonly deps: BrowserLinkOpenerDeps) {}

	openExternalLink(href: string): boolean {
		if (!this.deps.workspacePresented) return false;
		if (!this.deps.settings.openLinksInBrowserSurface) return false;
		const controller = this.deps.surfaces.browser();
		const result = normalizeBrowserUrl(href, controller.appOrigin);
		if (!result.ok) return false;
		controller.navigate(result.url);
		if (this.deps.workspace.isMobile) {
			void this.deps.workspace.focusMobileSingleton('browser');
		} else {
			// Sidebar placement keeps the chat visible next to the opened page.
			void this.deps.workspace.openSingleton('browser', 'sidebar');
		}
		return true;
	}
}
