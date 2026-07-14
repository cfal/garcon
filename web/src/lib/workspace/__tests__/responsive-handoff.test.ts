import { describe, expect, it } from 'vitest';
import {
	canonicalWorkspaceSnapshot,
	reduceWorkspaceLayout,
} from '$lib/stores/workspace-layout.svelte';
import { planDesktopReturnMutations, selectMobileEntrySurface } from '../responsive-handoff';

describe('selectMobileEntrySurface', () => {
	it('gives an open file dialog unconditional precedence', () => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:dialog', type: 'file', fileSessionId: 'dialog' },
				host: 'main',
			},
			{ type: 'place-in-dialog', surfaceId: 'file:dialog' },
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
		]);

		expect(selectMobileEntrySurface(snapshot, 'singleton:git')).toBe('file:dialog');
	});

	it('accepts only active visible host recency', () => {
		const openSidebar = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-sidebar-open', open: true },
		]);
		expect(selectMobileEntrySurface(openSidebar, 'singleton:files')).toBe('singleton:files');
		expect(selectMobileEntrySurface(openSidebar, 'singleton:commit')).toBe('singleton:chat');

		const closedSidebar = reduceWorkspaceLayout(openSidebar, [
			{ type: 'set-sidebar-open', open: false },
		]);
		expect(selectMobileEntrySurface(closedSidebar, 'singleton:files')).toBe('singleton:chat');

		const fullscreen = reduceWorkspaceLayout(openSidebar, [
			{ type: 'set-manual-fullscreen', enabled: true },
		]);
		expect(selectMobileEntrySurface(fullscreen, 'singleton:files')).toBe('singleton:chat');
	});
});

describe('planDesktopReturnMutations', () => {
	it('assigns mobile-only singletons to defaults and the most recent file to dialog', () => {
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
			{ type: 'assign-to-host', surfaceId: 'singleton:files', destination: 'sidebar' },
			{ type: 'assign-to-host', surfaceId: 'file:a', destination: 'main' },
		]);
		const restored = reduceWorkspaceLayout(mobile, mutations);
		expect(restored.mobileOnlySurfaceIds).toEqual([]);
		expect(restored.dialogFileSurfaceId).toBe('file:b');
		expect(restored.main.order).toContain('file:a');
		expect(restored.sidebar.order).toContain('singleton:files');
	});

	it('preserves an existing desktop dialog occupant and sends mobile files to main', () => {
		const layout = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:desktop', type: 'file', fileSessionId: 'desktop' },
				host: 'main',
			},
			{ type: 'place-in-dialog', surfaceId: 'file:desktop' },
			{
				type: 'register-surface',
				surface: { id: 'file:mobile', type: 'file', fileSessionId: 'mobile' },
			},
		]);

		expect(planDesktopReturnMutations(layout, ['file:mobile'])).toEqual([
			{ type: 'assign-to-host', surfaceId: 'file:mobile', destination: 'main' },
		]);
	});
});
