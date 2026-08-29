import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { planDesktopReturnMutations, selectMobileEntrySurface } from '../responsive-handoff';
import { windowIdOfSurface } from '../window-tree';

describe('selectMobileEntrySurface', () => {
	it('gives an open file dialog unconditional precedence', () => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:dialog', type: 'file', fileSessionId: 'dialog' },
				windowId: 'window-main',
			},
			{ type: 'place-in-dialog', surfaceId: 'file:dialog' },
			{
				type: 'register-surface',
				surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
				windowId: 'window-main',
			},
		]);

		expect(selectMobileEntrySurface(snapshot, 'singleton:git')).toBe('file:dialog');
	});

	it('accepts the last focused surface when it is a window-active tab', () => {
		const windows = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface-in-new-window',
				surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
				targetWindowId: 'window-main',
				edge: 'right',
				newWindowId: 'window-2',
				partitionId: 'partition-1',
			},
		]);
		expect(selectMobileEntrySurface(windows, 'singleton:git')).toBe('singleton:git');
		expect(selectMobileEntrySurface(windows, 'singleton:pull-requests')).toBe(
			'chat-view:window-main',
		);
	});

	it('projects the fullscreen window surface ahead of other window actives', () => {
		const fullscreen = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface-in-new-window',
				surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
				targetWindowId: 'window-main',
				edge: 'right',
				newWindowId: 'window-2',
				partitionId: 'partition-1',
			},
			{ type: 'retain-only-window', windowId: 'window-2' },
			{ type: 'set-fullscreen-window', windowId: 'window-2' },
		]);
		expect(selectMobileEntrySurface(fullscreen, 'chat-view:window-main')).toBe('singleton:git');
	});

	it('keeps a dialog ahead of the fullscreen window', () => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface-in-new-window',
				surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
				targetWindowId: 'window-main',
				edge: 'right',
				newWindowId: 'window-2',
				partitionId: 'partition-1',
			},
			{ type: 'retain-only-window', windowId: 'window-2' },
			{ type: 'set-fullscreen-window', windowId: 'window-2' },
			{
				type: 'register-surface',
				surface: { id: 'file:dialog', type: 'file', fileSessionId: 'dialog' },
			},
			{ type: 'place-in-dialog', surfaceId: 'file:dialog' },
		]);

		expect(selectMobileEntrySurface(snapshot, 'singleton:git')).toBe('file:dialog');
	});
});

describe('planDesktopReturnMutations', () => {
	it('assigns mobile-only surfaces to the Chat window and the most recent file to dialog', () => {
		const mobile = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:a', type: 'file', fileSessionId: 'a' },
			},
			{
				type: 'register-surface',
				surface: { id: 'file:b', type: 'file', fileSessionId: 'b' },
			},
			{ type: 'remove-surface', surfaceId: 'singleton:files' },
			{
				type: 'register-surface',
				surface: { id: 'singleton:files', type: 'singleton', kind: 'files' },
			},
		]);
		const mutations = planDesktopReturnMutations(mobile, ['file:b', 'singleton:files', 'file:a']);

		expect(mutations).toEqual([
			{ type: 'place-in-dialog', surfaceId: 'file:b' },
			{
				type: 'assign-to-window',
				surfaceId: 'singleton:files',
				destinationWindowId: 'window-main',
			},
			{ type: 'assign-to-window', surfaceId: 'file:a', destinationWindowId: 'window-main' },
		]);
		const restored = reduceWorkspaceLayout(mobile, mutations);
		expect(restored.mobileOnlySurfaceIds).toEqual([]);
		expect(restored.dialogFileSurfaceId).toBe('file:b');
		expect(windowIdOfSurface(restored.desktopRoot, 'file:a')).toBe('window-main');
		expect(windowIdOfSurface(restored.desktopRoot, 'singleton:files')).toBe('window-main');
	});

	it('preserves an existing desktop dialog occupant and sends mobile files to the Chat window', () => {
		const layout = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:desktop', type: 'file', fileSessionId: 'desktop' },
				windowId: 'window-main',
			},
			{ type: 'place-in-dialog', surfaceId: 'file:desktop' },
			{
				type: 'register-surface',
				surface: { id: 'file:mobile', type: 'file', fileSessionId: 'mobile' },
			},
		]);

		expect(planDesktopReturnMutations(layout, ['file:mobile'])).toEqual([
			{ type: 'assign-to-window', surfaceId: 'file:mobile', destinationWindowId: 'window-main' },
		]);
	});

	it('removes mobile-only History and Compare instead of assigning them to desktop', () => {
		const mobile = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: {
					id: 'singleton:git-history',
					type: 'singleton',
					kind: 'git-history',
				},
			},
			{
				type: 'register-surface',
				surface: {
					id: 'singleton:git-compare',
					type: 'singleton',
					kind: 'git-compare',
				},
			},
		]);

		expect(planDesktopReturnMutations(mobile, ['singleton:git-compare'])).toEqual([
			{ type: 'remove-surface', surfaceId: 'singleton:git-compare' },
			{ type: 'remove-surface', surfaceId: 'singleton:git-history' },
		]);
	});
});
