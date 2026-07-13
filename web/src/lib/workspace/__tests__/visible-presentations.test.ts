import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot, reduceWorkspaceLayout } from '$lib/stores/workspace-layout.svelte';
import { visiblePortablePresentations } from '../visible-presentations';

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
});
