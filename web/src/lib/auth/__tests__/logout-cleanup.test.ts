import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserLogout } from '$lib/utils/browser-data-lifetime';
import {
	clearBrowserPrivateData,
	clearTabPrivateData,
	reconcileTabPrivateData,
} from '../logout-cleanup';

let logout: BrowserLogout;
beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	logout = { epoch: 'next', deadline: Date.now() + 10_000, coordinated: false };
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('clears Garcon credentials, drafts, snapshots and paths without clearing unrelated origin data', async () => {
	vi.stubGlobal('indexedDB', undefined);
	for (const key of [
		'bearer-token',
		'chat_draft_test',
		'chat_snapshot_test',
		'chat_snapshot_index_v3',
		'workspace_layout_v2',
		'garcon-tickets-preferences-v1',
		'garcon.credential-update-pending',
	])
		localStorage.setItem(key, 'private');
	for (const key of [
		'garcon-ticket-draft-v1:test',
		'chat-canvas-recovery-v1:test',
		'terminal_client_id_v1',
	])
		sessionStorage.setItem(key, 'private');
	localStorage.setItem('garcon.logout-epoch', 'next');
	localStorage.setItem('unrelated-app', 'keep');
	sessionStorage.setItem('unrelated-tab', 'keep');
	expect(await clearBrowserPrivateData(logout)).toBe(true);
	expect(Object.keys(localStorage).sort()).toEqual(['garcon.logout-epoch', 'unrelated-app']);
	expect(Object.keys(sessionStorage).sort()).toEqual(['garcon.tab-logout-epoch', 'unrelated-tab']);
});

it('clears only private tab data on a missed logout epoch', () => {
	localStorage.setItem('garcon.logout-epoch', 'next');
	localStorage.setItem('bearer-token', 'fresh-login');
	sessionStorage.setItem('garcon.tab-logout-epoch', 'before');
	sessionStorage.setItem('garcon-ticket-draft-v1:test', 'old draft');
	expect(reconcileTabPrivateData()).toBe(true);
	expect(sessionStorage.getItem('garcon-ticket-draft-v1:test')).toBeNull();
	expect(localStorage.getItem('bearer-token')).toBe('fresh-login');
	sessionStorage.setItem('garcon-ticket-draft-v1:new', 'new draft');
	expect(reconcileTabPrivateData()).toBe(true);
	expect(sessionStorage.getItem('garcon-ticket-draft-v1:new')).toBe('new draft');
});

it('reports storage failures', async () => {
	vi.stubGlobal('indexedDB', undefined);
	sessionStorage.setItem('garcon-ticket-draft-v1:test', 'draft');
	vi.spyOn(sessionStorage, 'removeItem').mockImplementation(() => {
		throw new Error('blocked');
	});
	expect(clearTabPrivateData()).toBe(false);
	expect(await clearBrowserPrivateData(logout)).toBe(false);
});
