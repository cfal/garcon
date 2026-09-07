import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeControllerTestHost from './ThemeControllerTestHost.svelte';
import type { ThemePreference } from '../themes.js';

interface MatchMediaHarness {
	readonly listeners: Set<(event: MediaQueryListEvent) => void>;
	setDark(value: boolean): void;
}

function installMatchMedia(initialDark = false): MatchMediaHarness {
	let dark = initialDark;
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	vi.stubGlobal(
		'matchMedia',
		vi.fn(
			() =>
				({
					get matches() {
						return dark;
					},
					media: '(prefers-color-scheme: dark)',
					onchange: null,
					addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
						listeners.add(listener);
					},
					removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
						listeners.delete(listener);
					},
					addListener: vi.fn(),
					removeListener: vi.fn(),
					dispatchEvent: vi.fn(),
				}) as unknown as MediaQueryList,
		),
	);
	return {
		listeners,
		setDark(value: boolean) {
			dark = value;
			for (const listener of listeners) listener({ matches: dark } as MediaQueryListEvent);
		},
	};
}

function renderController(initialPreference: ThemePreference) {
	const setTerminalPresentation = vi.fn();
	const setEditorPresentation = vi.fn();
	const reportError = vi.fn();
	const rendered = render(ThemeControllerTestHost, {
		initialPreference,
		setTerminalPresentation,
		setEditorPresentation,
		reportError,
	});
	return { ...rendered, setTerminalPresentation, setEditorPresentation, reportError };
}

describe('ThemeController', () => {
	beforeEach(() => {
		document.head.innerHTML =
			'<meta name="theme-color" content="#000000"><meta name="apple-mobile-web-app-status-bar-style" content="default">';
		document.documentElement.removeAttribute('data-theme');
		document.documentElement.className = '';
		document.documentElement.style.cssText = '--terminal-bg: 0 0% 100%';
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('subscribes only in System mode and cleans the listener up', async () => {
		const media = installMatchMedia();
		const fixed = renderController({ mode: 'fixed', themeId: 'classic-light' });
		await waitFor(() => expect(fixed.setEditorPresentation).toHaveBeenCalledOnce());
		expect(media.listeners).toHaveLength(0);

		fixed.component.setPreference({
			mode: 'system',
			lightThemeId: 'classic-light',
			darkThemeId: 'classic-dark',
		});
		await waitFor(() => expect(media.listeners).toHaveLength(1));
		media.setDark(true);
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe('classic-dark'));

		fixed.component.setPreference({ mode: 'fixed', themeId: 'phosphor-light' });
		await waitFor(() => expect(media.listeners).toHaveLength(0));
	});

	it('projects root state and metadata before resolving the terminal background', async () => {
		installMatchMedia();
		const computedStyle = vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(() => {
			expect(document.documentElement.dataset.theme).toBe('phosphor-dark');
			expect(document.documentElement.classList.contains('dark')).toBe(true);
			expect(document.documentElement.style.colorScheme).toBe('dark');
			expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
				'#090b11',
			);
			return { getPropertyValue: () => '222 35% 4%' } as unknown as CSSStyleDeclaration;
		});
		const rendered = renderController({ mode: 'fixed', themeId: 'phosphor-dark' });

		await waitFor(() => expect(rendered.setTerminalPresentation).toHaveBeenCalledOnce());
		expect(rendered.setTerminalPresentation).toHaveBeenCalledWith({
			colorScheme: 'dark',
			rendererPalette: 'standard',
			background: 'rgb(7, 9, 14)',
		});
		expect(rendered.setEditorPresentation).toHaveBeenCalledWith({
			colorScheme: 'dark',
			rendererPalette: 'standard',
		});
		computedStyle.mockRestore();
	});

	it('reports an invalid terminal token once while continuing editor updates', async () => {
		installMatchMedia();
		vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({
			getPropertyValue: (property: string) =>
				property === '--background' ? '0 0% 100%' : 'invalid',
		} as unknown as CSSStyleDeclaration);
		const rendered = renderController({ mode: 'fixed', themeId: 'classic-light' });
		await waitFor(() => expect(rendered.setEditorPresentation).toHaveBeenCalledOnce());

		expect(rendered.setTerminalPresentation).not.toHaveBeenCalled();
		expect(rendered.reportError).toHaveBeenCalledOnce();
		rendered.component.setPreference({ mode: 'fixed', themeId: 'classic-dark' });
		await waitFor(() => expect(rendered.setEditorPresentation).toHaveBeenCalledTimes(2));
		rendered.component.setPreference({ mode: 'fixed', themeId: 'classic-light' });
		await waitFor(() => expect(rendered.setEditorPresentation).toHaveBeenCalledTimes(3));
		expect(rendered.reportError).toHaveBeenCalledTimes(2);
	});

	it('skips terminal projection when the browser does not resolve theme styles', async () => {
		installMatchMedia();
		vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({
			getPropertyValue: () => '',
		} as unknown as CSSStyleDeclaration);
		const rendered = renderController({ mode: 'fixed', themeId: 'phosphor-light' });
		await waitFor(() => expect(rendered.setEditorPresentation).toHaveBeenCalledOnce());

		expect(rendered.setTerminalPresentation).not.toHaveBeenCalled();
		expect(rendered.reportError).not.toHaveBeenCalled();
	});
});
