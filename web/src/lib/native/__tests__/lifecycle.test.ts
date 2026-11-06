import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { getNativeLifecycle } from '../lifecycle';
import NativeReadySignal from '$lib/components/layout/NativeReadySignal.svelte';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	delete window.__GARCON_NATIVE__;
});

it('is absent in browsers and hosts without lifecycle support', () => {
	expect(getNativeLifecycle()).toBeNull();
	render(NativeReadySignal);
	window.__GARCON_NATIVE__ = { version: 1, requestServerChooser() {} };
	expect(getNativeLifecycle()).toBeNull();
});

it('reports readiness after mounting and preserves capability method receivers', () => {
	const reports: string[] = [];
	const lifecycle = {
		requestReload() { expect(this).toBe(lifecycle); reports.push('reload'); },
		reportReady() { expect(this).toBe(lifecycle); reports.push('ready'); },
	};
	window.__GARCON_NATIVE__ = { version: 1, requestServerChooser() {}, lifecycle };
	expect(reports).toEqual([]);
	render(NativeReadySignal);
	expect(reports).toEqual(['ready']);
	getNativeLifecycle()?.requestReload();
	expect(reports).toEqual(['ready', 'reload']);
});

it('a failed readiness request does not tear down the web UI', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	window.__GARCON_NATIVE__ = {
		version: 1, requestServerChooser() {},
		lifecycle: { requestReload() {}, reportReady() { throw new Error('Synthetic failure'); } },
	};
	expect(() => render(NativeReadySignal)).not.toThrow();
	expect(warn).toHaveBeenCalledOnce();
});
