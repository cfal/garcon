import { describe, expect, it } from 'vitest';
import {
	canOmitCanonicalPullRequests,
	canOpenCanonicalSidebar,
	canonicalWorkspaceSnapshot,
	isCanonicalFirstRunLayout,
	nextSidebarSeedKind,
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
				host: 'main',
			},
		]);
		const focused = reduceWorkspaceLayout(canonical, [
			{ type: 'focus-host', host: 'main', surfaceId: singletonSurfaceId('git') },
		]);

		expect(isCanonicalFirstRunLayout(withLauncher)).toBe(false);
		expect(isCanonicalFirstRunLayout(focused)).toBe(false);
	});

	it('allows canonical Pull Requests omission while tolerating the launcher', () => {
		const withLauncher = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: TERMINAL_LAUNCHER_ID, type: 'terminal-launcher' },
				host: 'main',
			},
		]);
		expect(canOmitCanonicalPullRequests(withLauncher)).toBe(true);

		const pullRequestsActive = reduceWorkspaceLayout(withLauncher, [
			{
				type: 'focus-host',
				host: 'main',
				surfaceId: singletonSurfaceId('pull-requests'),
			},
		]);
		expect(canOmitCanonicalPullRequests(pullRequestsActive)).toBe(false);

		const noncanonical = reduceWorkspaceLayout(withLauncher, [
			{ type: 'move-to-host', surfaceId: singletonSurfaceId('files'), destination: 'main' },
		]);
		expect(canOmitCanonicalPullRequests(noncanonical)).toBe(false);
	});

	it('chooses the first missing sidebar default without moving an existing singleton', () => {
		const canonical = canonicalWorkspaceSnapshot();
		expect(nextSidebarSeedKind(canonical)).toBeNull();

		const withoutFiles = reduceWorkspaceLayout(canonical, [
			{ type: 'remove-surface', surfaceId: singletonSurfaceId('files') },
		]);
		expect(nextSidebarSeedKind(withoutFiles)).toBe('files');

		const withoutCommit = reduceWorkspaceLayout(canonical, [
			{ type: 'remove-surface', surfaceId: singletonSurfaceId('commit') },
		]);
		expect(nextSidebarSeedKind(withoutCommit)).toBe('commit');

		const defaultsInMain = reduceWorkspaceLayout(canonical, [
			{ type: 'move-to-host', surfaceId: singletonSurfaceId('files'), destination: 'main' },
			{ type: 'move-to-host', surfaceId: singletonSurfaceId('commit'), destination: 'main' },
			{ type: 'focus-host', host: 'main', surfaceId: CHAT_SURFACE_ID },
		]);
		expect(canOpenCanonicalSidebar(defaultsInMain)).toBe(false);
	});
});
