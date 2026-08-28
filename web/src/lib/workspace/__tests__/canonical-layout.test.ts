import { describe, expect, it } from 'vitest';
import {
	canOmitCanonicalPullRequests,
	canonicalWorkspaceSnapshot,
	isCanonicalFirstRunLayout,
} from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { CHAT_SURFACE_ID, TERMINAL_LAUNCHER_ID, singletonSurfaceId } from '../surface-types';

describe('canonical workspace layout', () => {
	it('recognizes first-run layouts with or without Pull Requests', () => {
		const canonical = canonicalWorkspaceSnapshot();
		expect(isCanonicalFirstRunLayout(canonical)).toBe(true);

		const withoutPullRequests = reduceWorkspaceLayout(canonical, [
			{ type: 'remove-surface', surfaceId: singletonSurfaceId('pull-requests') },
		]);
		expect(isCanonicalFirstRunLayout(withoutPullRequests)).toBe(true);
	});

	it('rejects launcher-derived and user-focused layouts as first-run state', () => {
		const canonical = canonicalWorkspaceSnapshot();
		const withLauncher = reduceWorkspaceLayout(canonical, [
			{
				type: 'register-surface',
				surface: { id: TERMINAL_LAUNCHER_ID, type: 'terminal-launcher' },
				paneId: 'pane-main',
			},
		]);
		const focused = reduceWorkspaceLayout(canonical, [
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: singletonSurfaceId('git') },
		]);

		expect(isCanonicalFirstRunLayout(withLauncher)).toBe(false);
		expect(isCanonicalFirstRunLayout(focused)).toBe(false);
	});

	it('rejects split layouts as first-run state', () => {
		const split = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'split-tab-to-edge',
				surfaceId: singletonSurfaceId('git'),
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
		]);
		expect(isCanonicalFirstRunLayout(split)).toBe(false);
		expect(canOmitCanonicalPullRequests(split)).toBe(false);
	});

	it('allows canonical Pull Requests omission while tolerating the launcher', () => {
		const withLauncher = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: TERMINAL_LAUNCHER_ID, type: 'terminal-launcher' },
				paneId: 'pane-main',
			},
		]);
		expect(canOmitCanonicalPullRequests(withLauncher)).toBe(true);

		const pullRequestsActive = reduceWorkspaceLayout(withLauncher, [
			{
				type: 'activate-pane-tab',
				paneId: 'pane-main',
				surfaceId: singletonSurfaceId('pull-requests'),
			},
		]);
		expect(canOmitCanonicalPullRequests(pullRequestsActive)).toBe(false);

		const noncanonical = reduceWorkspaceLayout(withLauncher, [
			{
				type: 'register-surface',
				surface: { id: singletonSurfaceId('files'), type: 'singleton', kind: 'files' },
				paneId: 'pane-main',
			},
		]);
		expect(canOmitCanonicalPullRequests(noncanonical)).toBe(false);
	});

	it('always places chat first in the canonical pane', () => {
		const canonical = canonicalWorkspaceSnapshot();
		expect(canonical.desktopRoot.type).toBe('pane');
		if (canonical.desktopRoot.type !== 'pane') throw new Error('expected pane root');
		expect(canonical.desktopRoot.tabs.order[0]).toBe(CHAT_SURFACE_ID);
		expect(canonical.desktopRoot.tabs.activeId).toBe(CHAT_SURFACE_ID);
	});
});
