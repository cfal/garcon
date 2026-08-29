import { describe, expect, it } from 'vitest';
import {
	CANONICAL_CHAT_SURFACE_ID,
	CANONICAL_WINDOW_ID,
	canonicalWorkspaceSnapshot,
	isCanonicalFirstRunLayout,
} from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { singletonSurfaceId } from '../surface-types';

describe('canonical workspace layout', () => {
	it('contains one window with one empty Chat view', () => {
		const canonical = canonicalWorkspaceSnapshot();
		expect(canonical.desktopRoot).toEqual({
			type: 'window',
			id: CANONICAL_WINDOW_ID,
			tabs: {
				order: [CANONICAL_CHAT_SURFACE_ID],
				activeId: CANONICAL_CHAT_SURFACE_ID,
				mru: [CANONICAL_CHAT_SURFACE_ID],
			},
		});
		expect(canonical.surfaces).toEqual({
			[CANONICAL_CHAT_SURFACE_ID]: {
				id: CANONICAL_CHAT_SURFACE_ID,
				type: 'chat',
				chatId: null,
			},
		});
		expect(canonical.mobileActiveSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(isCanonicalFirstRunLayout(canonical)).toBe(true);
	});

	it('rejects a selected Chat, an added tab, or another window as first-run state', () => {
		const selected = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-window-chat', windowId: CANONICAL_WINDOW_ID, chatId: 'chat-a' },
		]);
		const withTab = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: singletonSurfaceId('git'), type: 'singleton', kind: 'git' },
				windowId: CANONICAL_WINDOW_ID,
			},
		]);
		const withWindow = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'open-chat-in-new-window',
				chatId: 'chat-b',
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-secondary',
				partitionId: 'partition-root',
			},
		]);

		expect(isCanonicalFirstRunLayout(selected)).toBe(false);
		expect(isCanonicalFirstRunLayout(withTab)).toBe(false);
		expect(isCanonicalFirstRunLayout(withWindow)).toBe(false);
	});
});
