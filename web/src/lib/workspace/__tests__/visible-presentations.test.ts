import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import {
	nextRetainedSingletonPresentationKeys,
	renderedPortablePresentations,
	visiblePresentationMap,
	visiblePortablePresentations,
} from '../visible-presentations';
import type { WorkspaceWindowId, WorkspaceLayoutSnapshot } from '../surface-types';

function twoWindowLayout(): WorkspaceLayoutSnapshot {
	return reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
		{
			type: 'register-surface-in-new-window',
			surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
			targetWindowId: 'window-main',
			edge: 'right',
			newWindowId: 'window-2',
			partitionId: 'partition-1',
		},
	]);
}

describe('visiblePortablePresentations', () => {
	it('returns the active surface of every presented window on desktop', () => {
		const snapshot = twoWindowLayout();

		expect(visiblePortablePresentations(snapshot, false)).toEqual([
			{ surfaceId: 'singleton:git', presentation: 'window-2' },
		]);
	});

	it('omits the chat surface and projects one mobile surface', () => {
		const snapshot = twoWindowLayout();
		expect(
			visiblePortablePresentations(snapshot, false).some(
				({ surfaceId }) => surfaceId === 'chat-view:window-main',
			),
		).toBe(false);

		const mobile = reduceWorkspaceLayout(snapshot, [
			{
				type: 'set-mobile-presentation',
				activeId: 'singleton:git',
				returnStack: [],
			},
		]);
		expect(visiblePortablePresentations(mobile, true)).toEqual([
			{ surfaceId: 'singleton:git', presentation: 'mobile' },
		]);
	});

	it('projects only the fullscreen window on desktop and keeps mobile projection', () => {
		const snapshot = reduceWorkspaceLayout(twoWindowLayout(), [
			{ type: 'retain-only-window', windowId: 'window-2' },
			{ type: 'set-fullscreen-window', windowId: 'window-2' },
		]);
		expect([...visiblePresentationMap(snapshot, 'desktop')]).toEqual([
			['window-2', 'singleton:git'],
		]);
		expect([...visiblePresentationMap(snapshot, 'mobile')]).toEqual([['mobile', 'singleton:git']]);
	});

	it('retains activated singleton renderers per window without retaining session surfaces', () => {
		const gitActive = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
				windowId: 'window-main',
			},
			{
				type: 'activate-window-tab',
				windowId: 'window-main',
				surfaceId: 'singleton:git',
			},
		]);
		const gitVisible = visiblePortablePresentations(gitActive, false);
		const retained = nextRetainedSingletonPresentationKeys(gitActive, false, gitVisible, new Set());
		expect([...retained]).toEqual(['window-main:singleton:git']);

		const chatActive = reduceWorkspaceLayout(gitActive, [
			{
				type: 'activate-window-tab',
				windowId: 'window-main',
				surfaceId: 'chat-view:window-main',
			},
		]);
		const chatVisible = visiblePortablePresentations(chatActive, false);
		const nextRetained = nextRetainedSingletonPresentationKeys(
			chatActive,
			false,
			chatVisible,
			retained,
		);

		expect(renderedPortablePresentations(chatActive, false, chatVisible, nextRetained)).toEqual([
			{
				surfaceId: 'singleton:git',
				presentation: 'window-main' as WorkspaceWindowId,
				windowId: 'window-main' as WorkspaceWindowId,
				visible: false,
			},
		]);
	});

	it('drops retained renderers for destroyed windows and never retains on mobile', () => {
		const snapshot = twoWindowLayout();
		const visible = visiblePortablePresentations(snapshot, false);
		const retained = nextRetainedSingletonPresentationKeys(snapshot, false, visible, new Set());
		expect([...retained].sort()).toEqual(['window-2:singleton:git']);

		const fullscreen = reduceWorkspaceLayout(snapshot, [
			{ type: 'retain-only-window', windowId: 'window-2' },
			{ type: 'set-fullscreen-window', windowId: 'window-2' },
		]);
		const fullscreenVisible = visiblePortablePresentations(fullscreen, false);
		expect(
			nextRetainedSingletonPresentationKeys(fullscreen, false, fullscreenVisible, retained),
		).toEqual(new Set(['window-2:singleton:git']));
		expect(nextRetainedSingletonPresentationKeys(snapshot, true, visible, retained).size).toBe(0);
	});
});
