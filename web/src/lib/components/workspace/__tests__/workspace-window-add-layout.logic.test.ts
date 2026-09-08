import { describe, expect, it } from 'vitest';
import { resolveWorkspaceWindowInlineAddActionCount } from '../workspace-window-add-layout.js';

describe('resolveWorkspaceWindowInlineAddActionCount', () => {
	it('keeps every action in the menu until tab measurements are available', () => {
		expect(
			resolveWorkspaceWindowInlineAddActionCount({
				measure: null,
				eligibleCount: 4,
				currentInlineCount: 0,
			}),
		).toBe(0);
	});

	it('uses only width left after every full tab title', () => {
		expect(
			resolveWorkspaceWindowInlineAddActionCount({
				measure: { naturalWidth: 200, viewportWidth: 318 },
				eligibleCount: 5,
				currentInlineCount: 0,
			}),
		).toBe(3);
	});

	it('admits an action prefix at the exact boundary with an overflow menu', () => {
		expect(
			resolveWorkspaceWindowInlineAddActionCount({
				measure: { naturalWidth: 200, viewportWidth: 260 },
				eligibleCount: 4,
				currentInlineCount: 0,
			}),
		).toBe(2);
	});

	it('clamps spare capacity to the eligible action count', () => {
		expect(
			resolveWorkspaceWindowInlineAddActionCount({
				measure: { naturalWidth: 100, viewportWidth: 1_000 },
				eligibleCount: 3,
				currentInlineCount: 0,
			}),
		).toBe(3);
	});

	it('remains stable after inline actions consume the viewport slack', () => {
		expect(
			resolveWorkspaceWindowInlineAddActionCount({
				measure: { naturalWidth: 200, viewportWidth: 200 },
				eligibleCount: 5,
				currentInlineCount: 3,
			}),
		).toBe(3);
	});

	it('removes every inline action when full tabs exceed the shared width', () => {
		expect(
			resolveWorkspaceWindowInlineAddActionCount({
				measure: { naturalWidth: 320, viewportWidth: 200 },
				eligibleCount: 4,
				currentInlineCount: 2,
			}),
		).toBe(0);
	});

	it('recovers when shrinking below the current inline control width', () => {
		expect(
			resolveWorkspaceWindowInlineAddActionCount({
				measure: { naturalWidth: 100, viewportWidth: 0 },
				eligibleCount: 8,
				currentInlineCount: 8,
			}),
		).toBe(0);
	});

	it('uses the removed menu button slot when every action can be inline', () => {
		expect(
			resolveWorkspaceWindowInlineAddActionCount({
				measure: { naturalWidth: 200, viewportWidth: 288 },
				eligibleCount: 3,
				currentInlineCount: 0,
			}),
		).toBe(3);
	});
});
