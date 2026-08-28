import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { planDesktopReturnMutations, selectMobileEntrySurface } from '../responsive-handoff';
import { paneIdOfSurface } from '../pane-tree';

describe('selectMobileEntrySurface', () => {
	it('gives an open file dialog unconditional precedence', () => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:dialog', type: 'file', fileSessionId: 'dialog' },
				paneId: 'pane-main',
			},
			{ type: 'place-in-dialog', surfaceId: 'file:dialog' },
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' },
		]);

		expect(selectMobileEntrySurface(snapshot, 'singleton:git')).toBe('file:dialog');
	});

	it('accepts the last focused surface when it is a pane-active tab', () => {
		const split = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'split-tab-to-edge',
				surfaceId: 'singleton:git',
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
		]);
		expect(selectMobileEntrySurface(split, 'singleton:git')).toBe('singleton:git');
		expect(selectMobileEntrySurface(split, 'singleton:pull-requests')).toBe('singleton:chat');
	});

	it('projects the fullscreen pane surface ahead of pane actives', () => {
		const fullscreen = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'split-tab-to-edge',
				surfaceId: 'singleton:git',
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
			{ type: 'set-fullscreen-pane', paneId: 'pane-2' },
		]);
		expect(selectMobileEntrySurface(fullscreen, 'singleton:chat')).toBe('singleton:git');
	});

	it('keeps a dialog ahead of the fullscreen pane', () => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'split-tab-to-edge',
				surfaceId: 'singleton:git',
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
			{ type: 'set-fullscreen-pane', paneId: 'pane-2' },
			{
				type: 'register-surface',
				surface: { id: 'file:dialog', type: 'file', fileSessionId: 'dialog' },
				paneId: 'pane-main',
			},
			{ type: 'place-in-dialog', surfaceId: 'file:dialog' },
		]);

		expect(selectMobileEntrySurface(snapshot, 'singleton:git')).toBe('file:dialog');
	});
});

describe('planDesktopReturnMutations', () => {
	it('assigns mobile-only surfaces to the chat pane and the most recent file to dialog', () => {
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
			{ type: 'assign-to-pane', surfaceId: 'singleton:files', destinationPaneId: 'pane-main' },
			{ type: 'assign-to-pane', surfaceId: 'file:a', destinationPaneId: 'pane-main' },
		]);
		const restored = reduceWorkspaceLayout(mobile, mutations);
		expect(restored.mobileOnlySurfaceIds).toEqual([]);
		expect(restored.dialogFileSurfaceId).toBe('file:b');
		expect(paneIdOfSurface(restored.desktopRoot, 'file:a')).toBe('pane-main');
		expect(paneIdOfSurface(restored.desktopRoot, 'singleton:files')).toBe('pane-main');
	});

	it('preserves an existing desktop dialog occupant and sends mobile files to the chat pane', () => {
		const layout = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:desktop', type: 'file', fileSessionId: 'desktop' },
				paneId: 'pane-main',
			},
			{ type: 'place-in-dialog', surfaceId: 'file:desktop' },
			{
				type: 'register-surface',
				surface: { id: 'file:mobile', type: 'file', fileSessionId: 'mobile' },
			},
		]);

		expect(planDesktopReturnMutations(layout, ['file:mobile'])).toEqual([
			{ type: 'assign-to-pane', surfaceId: 'file:mobile', destinationPaneId: 'pane-main' },
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
