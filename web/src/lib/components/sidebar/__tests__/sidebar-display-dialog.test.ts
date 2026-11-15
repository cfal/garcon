import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
import SidebarDisplayDialogHost from './SidebarDisplayDialogHost.svelte';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it('previews drafts without writes and discards Cancel', async () => {
	const settings = createLocalSettingsStore();
	const apply = vi.spyOn(settings, 'setSidebarDisplay');
	render(SidebarDisplayDialogHost, { settings });
	await fireEvent.click(screen.getByRole('checkbox', { name: 'Project path' }));
	await fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));
	const preview = document.querySelector('[data-sidebar-display-preview]')!;
	expect(preview.querySelectorAll('[data-typography-chat-list]')).toHaveLength(3);
	expect(preview.querySelectorAll('[data-sidebar-project-header]')).toHaveLength(3);
	expect(preview.querySelector('[inert]')).toBeTruthy();
	expect(settings.sidebarChatItemLayout).toBe('single-line');
	expect(apply).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	expect(apply).not.toHaveBeenCalled();
	expect(screen.queryByRole('dialog')).toBeNull();
	settings.destroy();
});

it('retains moved-field focus, applies together, and preserves popup preferences', async () => {
	const settings = createLocalSettingsStore();
	settings.toggle('sidebarNestDelegatedChats');
	settings.set('sidebarSortMode', 'manual');
	const apply = vi.spyOn(settings, 'setSidebarDisplay');
	render(SidebarDisplayDialogHost, { settings });
	const up = screen.getByRole('button', { name: 'Move Project path up' });
	up.focus();
	await fireEvent.click(up);
	expect(
		document.activeElement?.closest('[data-grouping-field]')?.getAttribute('data-grouping-field'),
	).toBe('project');
	await fireEvent.click(screen.getByRole('checkbox', { name: 'Project path' }));
	await fireEvent.click(screen.getByRole('checkbox', { name: 'Combine nested paths' }));
	await fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
	await fireEvent.click(screen.getByRole('checkbox', { name: 'Activity' }));
	expect(screen.getAllByRole('option')).toHaveLength(9);
	await fireEvent.change(screen.getByRole('combobox'), { target: { value: '2-weeks' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
	expect(apply).toHaveBeenCalledOnce();
	expect(settings.sidebarGroupingFields[0]).toEqual({ field: 'project', enabled: true });
	expect(settings.sidebarChatItemLayout).toBe('compact');
	expect(settings.sidebarInactivityDuration).toBe('2-weeks');
	expect(settings.sidebarGroupNestedProjectPaths).toBe(true);
	expect(settings.sidebarNestDelegatedChats).toBe(true);
	expect(settings.sidebarSortMode).toBe('manual');
	settings.destroy();
});

it('resets only the draft and keeps inactive options disabled', async () => {
	const settings = createLocalSettingsStore();
	settings.set('sidebarChatItemLayout', 'detailed');
	render(SidebarDisplayDialogHost, { settings });
	await fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
	expect(settings.sidebarChatItemLayout).toBe('detailed');
	expect(screen.getByRole('radio', { name: 'Single-line' })).toHaveProperty('checked', true);
	expect(screen.getByRole('checkbox', { name: 'Combine nested paths' })).toHaveProperty(
		'disabled',
		true,
	);
	expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
	expect(within(screen.getByRole('dialog')).queryByRole('radio', { name: 'Manual' })).toBeNull();
	await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
	expect(settings.sidebarChatItemLayout).toBe('detailed');
	settings.destroy();
});
