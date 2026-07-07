import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppTitleStore } from '../app-title.svelte';

describe('AppTitleStore', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('uses Garcon when no bootstrap is present', () => {
		vi.stubGlobal('__GARCON_APP_TITLE__', undefined);

		const store = new AppTitleStore();

		expect(store.title).toBe('Garcon');
		expect(store.version).toBe(0);
	});

	it('uses the server bootstrap before remote settings load', () => {
		vi.stubGlobal('__GARCON_APP_TITLE__', { title: 'Garcon - Work', version: 7 });

		const store = new AppTitleStore();

		expect(store.title).toBe('Garcon - Work');
		expect(store.version).toBe(7);
	});

	it('falls back to Garcon for an invalid bootstrap title', () => {
		vi.stubGlobal('__GARCON_APP_TITLE__', { title: '   ', version: Number.MAX_SAFE_INTEGER + 1 });

		const store = new AppTitleStore();

		expect(store.title).toBe('Garcon');
		expect(store.version).toBe(0);
	});
});
