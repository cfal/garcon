import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import {
	nextRetainedSingletonPresentationKeys,
	renderedPortablePresentations,
	visiblePresentationMap,
	visiblePortablePresentations,
} from '../visible-presentations';
import type { PaneId, WorkspaceLayoutSnapshot } from '../surface-types';

function twoPaneLayout(): WorkspaceLayoutSnapshot {
	return reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
		{
			type: 'split-tab-to-edge',
			surfaceId: 'singleton:git',
			targetPaneId: 'pane-main',
			edge: 'right',
			newPaneId: 'pane-2',
			splitId: 'split-1',
		},
	]);
}

describe('visiblePortablePresentations', () => {
	it('returns the active surface of every presented pane on desktop', () => {
		const snapshot = twoPaneLayout();

		expect(visiblePortablePresentations(snapshot, false)).toEqual([
			{ surfaceId: 'singleton:git', presentation: 'pane-2' },
		]);
	});

	it('omits the chat surface and projects one mobile surface', () => {
		const snapshot = twoPaneLayout();
		expect(
			visiblePortablePresentations(snapshot, false).some(
				({ surfaceId }) => surfaceId === 'singleton:chat',
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

	it('projects only the fullscreen pane on desktop and keeps mobile projection', () => {
		const snapshot = reduceWorkspaceLayout(twoPaneLayout(), [
			{ type: 'set-fullscreen-pane', paneId: 'pane-2' },
		]);
		expect([...visiblePresentationMap(snapshot, 'desktop')]).toEqual([
			['pane-2', 'singleton:git'],
		]);
		expect([...visiblePresentationMap(snapshot, 'mobile')]).toEqual([
			['mobile', 'singleton:chat'],
		]);
	});

	it('retains activated singleton renderers per pane without retaining session surfaces', () => {
		const gitActive = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' },
		]);
		const gitVisible = visiblePortablePresentations(gitActive, false);
		const retained = nextRetainedSingletonPresentationKeys(gitActive, false, gitVisible, new Set());
		expect([...retained]).toEqual(['pane-main:singleton:git']);

		const chatActive = reduceWorkspaceLayout(gitActive, [
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:chat' },
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
				presentation: 'pane-main' as PaneId,
				paneId: 'pane-main' as PaneId,
				visible: false,
			},
		]);
	});

	it('drops retained renderers for panes hidden by fullscreen and never retains on mobile', () => {
		const snapshot = twoPaneLayout();
		const visible = visiblePortablePresentations(snapshot, false);
		const retained = nextRetainedSingletonPresentationKeys(snapshot, false, visible, new Set());
		expect([...retained].sort()).toEqual(['pane-2:singleton:git']);

		const fullscreen = reduceWorkspaceLayout(snapshot, [
			{ type: 'set-fullscreen-pane', paneId: 'pane-2' },
		]);
		const fullscreenVisible = visiblePortablePresentations(fullscreen, false);
		expect(
			nextRetainedSingletonPresentationKeys(fullscreen, false, fullscreenVisible, retained),
		).toEqual(new Set(['pane-2:singleton:git']));
		expect(nextRetainedSingletonPresentationKeys(snapshot, true, visible, retained).size).toBe(0);
	});
});
