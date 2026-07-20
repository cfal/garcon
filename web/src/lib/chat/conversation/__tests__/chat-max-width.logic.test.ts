import { describe, expect, it } from 'vitest';
import {
	CHAT_DOCK_SHELL_BASE_CLASS,
	CHAT_DOCK_SURFACE_CLASS,
	CHAT_FEED_CONTENT_BASE_CLASS,
	CHAT_MAX_WIDTH_COMPOSER_SPACING_CLASS,
	CHAT_MAX_WIDTH_DOCK_FRAME_CLASS,
	CHAT_MAX_WIDTH_DOCK_SHELL_CLASS,
	CHAT_MAX_WIDTH_FEED_CONTENT_CLASS,
} from '$lib/chat/conversation/chat-max-width.js';

// Maps Tailwind px utilities to pixel values so the feed-vs-composer inset
// invariant can be compared numerically across layouts.
const NAMED_PX: Record<string, number> = {
	'1': 4,
	'2': 8,
	'3': 12,
	'4': 16,
	'5': 20,
	'6': 24,
	'8': 32,
};

function parsePxValue(raw: string): number | null {
	const arbitrary = raw.match(/^\[(\d+)px\]$/);
	if (arbitrary) return Number(arbitrary[1]);
	return NAMED_PX[raw] ?? null;
}

// Extracts the horizontal padding (px) for a given breakpoint prefix.
// prefix '' matches an unprefixed mobile token (e.g. `px-4`); 'lg:' matches
// the desktop token (e.g. `lg:px-5`). Variant-prefixed tokens are skipped
// when extracting the mobile value.
function extractPx(classString: string, prefix: '' | 'lg:' = ''): number | null {
	const lead = prefix === 'lg:' ? 'lg:px-' : 'px-';
	for (const token of classString.split(/\s+/)) {
		if (!token.startsWith(lead)) continue;
		// Avoid matching `lg:px-...` when extracting the unprefixed mobile value.
		if (prefix === '' && token.startsWith('lg:')) continue;
		return parsePxValue(token.slice(lead.length));
	}
	return null;
}

describe('chat max width classes', () => {
	it('keeps the base feed class focused on layout without baking in a horizontal inset', () => {
		expect(CHAT_FEED_CONTENT_BASE_CLASS).not.toContain('px-');
	});

	it('reduces the none transcript inset below the previous values', () => {
		// Mobile reduced from 29px (px-[29px]) to 16px (px-4).
		expect(extractPx(CHAT_MAX_WIDTH_FEED_CONTENT_CLASS.none, '')).toBe(16);
		// Desktop reduced from 32px (lg:px-8) to 20px (lg:px-5).
		expect(extractPx(CHAT_MAX_WIDTH_FEED_CONTENT_CLASS.none, 'lg:')).toBe(20);
	});

	it('keeps the none transcript width inside the composer in both layouts', () => {
		// Mobile (small layout): feed px-4 (16px) must exceed composer px-2 (8px).
		const feedMobile = extractPx(CHAT_MAX_WIDTH_FEED_CONTENT_CLASS.none, '');
		const composerMobile = extractPx(CHAT_DOCK_SHELL_BASE_CLASS, '');
		expect(feedMobile).toBe(16);
		expect(composerMobile).toBe(8);
		expect(feedMobile!).toBeGreaterThan(composerMobile!);

		// Desktop (large layout): feed lg:px-5 (20px) must exceed composer lg:px-3 (12px).
		const feedDesktop = extractPx(CHAT_MAX_WIDTH_FEED_CONTENT_CLASS.none, 'lg:');
		const composerDesktop = extractPx(CHAT_MAX_WIDTH_DOCK_SHELL_CLASS.none, 'lg:');
		expect(feedDesktop).toBe(20);
		expect(composerDesktop).toBe(12);
		expect(feedDesktop!).toBeGreaterThan(composerDesktop!);
	});

	it('preserves the mobile transcript inset for constrained width options', () => {
		expect(CHAT_MAX_WIDTH_FEED_CONTENT_CLASS.large).toContain('px-[29px]');
		expect(CHAT_MAX_WIDTH_FEED_CONTENT_CLASS.medium).toContain('px-[29px]');
		expect(CHAT_MAX_WIDTH_FEED_CONTENT_CLASS.small).toContain('px-[29px]');
	});

	it('defines one shared frame for the composer and queued-input tray', () => {
		expect(CHAT_MAX_WIDTH_DOCK_FRAME_CLASS).toEqual({
			none: '',
			large: 'lg:mx-auto lg:max-w-5xl',
			medium: 'lg:mx-auto lg:max-w-4xl',
			small: 'lg:mx-auto lg:max-w-3xl',
		});
		expect(CHAT_DOCK_SURFACE_CLASS).toContain('rounded-2xl');
		expect(CHAT_DOCK_SURFACE_CLASS).toContain('border-border');
		expect(CHAT_DOCK_SURFACE_CLASS).toContain('bg-card');
		expect(CHAT_DOCK_SURFACE_CLASS).toContain('shadow-sm');
	});

	it('keeps composer-only bottom spacing independent of dock alignment', () => {
		expect(CHAT_MAX_WIDTH_COMPOSER_SPACING_CLASS.none).toBe('pb-2');
		expect(CHAT_MAX_WIDTH_COMPOSER_SPACING_CLASS.large).toContain('lg:pb-4');
		expect(CHAT_DOCK_SHELL_BASE_CLASS).not.toContain('pb-');
	});
});
