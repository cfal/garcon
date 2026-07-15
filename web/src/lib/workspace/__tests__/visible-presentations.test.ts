import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import {
	nextRetainedSingletonPresentationKeys,
	renderedPortablePresentations,
	visiblePortablePresentations,
} from '../visible-presentations';

describe('visiblePortablePresentations', () => {
	it('returns only the active main and presented sidebar surfaces on desktop', () => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
			{ type: 'set-sidebar-open', open: true },
		]);

		expect(visiblePortablePresentations(snapshot, false)).toEqual([
			{ surfaceId: 'singleton:git', presentation: 'main' },
			{ surfaceId: 'singleton:files', presentation: 'sidebar' },
		]);
		expect(
			visiblePortablePresentations(snapshot, false).some(
				({ surfaceId }) => surfaceId === 'singleton:pull-requests',
			),
		).toBe(false);
	});

	it('omits a hidden sidebar and projects exactly one portable mobile surface', () => {
		const desktop = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
		]);
		expect(visiblePortablePresentations(desktop, false)).toEqual([
			{ surfaceId: 'singleton:git', presentation: 'main' },
		]);

		const mobile = reduceWorkspaceLayout(desktop, [
			{
				type: 'set-mobile-presentation',
				activeId: 'singleton:files',
				returnStack: [],
			},
		]);
		expect(visiblePortablePresentations(mobile, true)).toEqual([
			{ surfaceId: 'singleton:files', presentation: 'mobile' },
		]);
	});

	it('retains activated desktop singleton renderers without retaining session surfaces', () => {
		const gitActive = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
			{ type: 'set-sidebar-open', open: true },
		]);
		const gitVisible = visiblePortablePresentations(gitActive, false);
		const retained = nextRetainedSingletonPresentationKeys(gitActive, false, gitVisible, new Set());

		const chatActive = reduceWorkspaceLayout(gitActive, [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:chat' },
		]);
		const chatVisible = visiblePortablePresentations(chatActive, false);
		const nextRetained = nextRetainedSingletonPresentationKeys(
			chatActive,
			false,
			chatVisible,
			retained,
		);

		expect(renderedPortablePresentations(chatActive, false, chatVisible, nextRetained)).toEqual([
			{ surfaceId: 'singleton:git', presentation: 'main', visible: false },
			{ surfaceId: 'singleton:files', presentation: 'sidebar', visible: true },
		]);
	});

	it('drops retained sidebar renderers when the sidebar hides and never retains them on mobile', () => {
		const open = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-sidebar-open', open: true },
		]);
		const visible = visiblePortablePresentations(open, false);
		const retained = nextRetainedSingletonPresentationKeys(open, false, visible, new Set());
		expect([...retained]).toEqual(['sidebar:singleton:files']);

		const closed = reduceWorkspaceLayout(open, [{ type: 'set-sidebar-open', open: false }]);
		expect(nextRetainedSingletonPresentationKeys(closed, false, [], retained).size).toBe(0);
		expect(nextRetainedSingletonPresentationKeys(open, true, visible, retained).size).toBe(0);
	});
});
