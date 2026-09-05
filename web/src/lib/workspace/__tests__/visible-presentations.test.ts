import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import {
	nextRetainedSingletonPresentationKeys,
	renderedPortablePresentations,
	visibleChatPresentations,
	visiblePresentationMap,
	visiblePortablePresentations,
} from '../visible-presentations';
import type { WorkspaceWindowId, WorkspaceLayoutSnapshot } from '../surface-types';

function layoutWithGitWindow(): WorkspaceLayoutSnapshot {
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
	it('returns every visible chat surface and excludes hidden panels', () => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-window-chat', windowId: 'window-main', chatId: 'chat-1' },
			{
				type: 'open-chat-in-new-window',
				chatId: 'chat-2',
				targetWindowId: 'window-main',
				edge: 'right',
				newWindowId: 'window-2',
				partitionId: 'partition-1',
			},
		]);

		expect(visibleChatPresentations(snapshot, 'desktop')).toEqual([
			{
				surfaceId: 'chat-view:window-main',
				chatId: 'chat-1',
				presentation: 'window-main',
				windowId: 'window-main',
			},
			{
				surfaceId: 'chat-view:window-2',
				chatId: 'chat-2',
				presentation: 'window-2',
				windowId: 'window-2',
			},
		]);

		const fullscreen = reduceWorkspaceLayout(snapshot, [
			{ type: 'set-fullscreen-window', windowId: 'window-2' },
		]);
		expect(visibleChatPresentations(fullscreen, 'desktop')).toHaveLength(1);
	});

	it('returns at most the active mobile chat and omits empty chat descriptors', () => {
		const empty = canonicalWorkspaceSnapshot();
		expect(visibleChatPresentations(empty, 'mobile')).toEqual([]);

		const populated = reduceWorkspaceLayout(empty, [
			{ type: 'set-window-chat', windowId: 'window-main', chatId: 'chat-1' },
		]);
		expect(visibleChatPresentations(populated, 'mobile')).toEqual([
			{
				surfaceId: 'chat-view:window-main',
				chatId: 'chat-1',
				presentation: 'mobile',
				windowId: null,
			},
		]);
	});

	it('returns the active surface of every presented window on desktop', () => {
		const snapshot = layoutWithGitWindow();

		expect(visiblePortablePresentations(snapshot, false)).toEqual([
			{ surfaceId: 'singleton:git', presentation: 'window-2' },
			{ surfaceId: 'singleton:files', presentation: 'window-files' },
		]);
	});

	it('omits the chat surface and projects one mobile surface', () => {
		const snapshot = layoutWithGitWindow();
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
		const snapshot = reduceWorkspaceLayout(layoutWithGitWindow(), [
			{ type: 'set-fullscreen-window', windowId: 'window-2' },
		]);
		expect([...visiblePresentationMap(snapshot, 'desktop')]).toEqual([
			['window-2', 'singleton:git'],
		]);
		expect([...visiblePresentationMap(snapshot, 'mobile')]).toEqual([
			['mobile', 'chat-view:window-main'],
		]);
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
		expect([...retained]).toEqual(['window-main:singleton:git', 'window-files:singleton:files']);

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
			{
				surfaceId: 'singleton:files',
				presentation: 'window-files' as WorkspaceWindowId,
				windowId: 'window-files' as WorkspaceWindowId,
				visible: true,
			},
		]);
	});

	it('drops retained renderers for destroyed windows and never retains on mobile', () => {
		const snapshot = layoutWithGitWindow();
		const visible = visiblePortablePresentations(snapshot, false);
		const retained = nextRetainedSingletonPresentationKeys(snapshot, false, visible, new Set());
		expect([...retained].sort()).toEqual(['window-2:singleton:git', 'window-files:singleton:files']);

		const fullscreen = reduceWorkspaceLayout(snapshot, [
			{ type: 'set-fullscreen-window', windowId: 'window-2' },
		]);
		const fullscreenVisible = visiblePortablePresentations(fullscreen, false);
		expect(
			nextRetainedSingletonPresentationKeys(fullscreen, false, fullscreenVisible, retained),
		).toEqual(new Set(['window-2:singleton:git', 'window-files:singleton:files']));
		expect(nextRetainedSingletonPresentationKeys(snapshot, true, visible, retained).size).toBe(0);
	});
});
