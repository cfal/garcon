import { render, screen } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import SidebarChatStatusIndicator from '../SidebarChatStatusIndicator.svelte';

describe('SidebarChatStatusIndicator', () => {
	it.each([
		['working', 'Chat is processing', '.sidebar-chat-status-spinner'],
		['complete', 'Chat complete', '.bg-sidebar-chat-complete'],
		['error', 'Chat error', '.bg-sidebar-chat-error'],
		['pending-user-action', 'Pending user action', '.text-status-warning'],
	] as const)('renders the %s indicator with an accessible label', (status, label, selector) => {
		const view = render(SidebarChatStatusIndicator, { status });
		const indicator = view.container.querySelector('[data-slot="sidebar-chat-status"]');
		expect(indicator?.getAttribute('title')).toBe(label);
		expect(indicator?.querySelector(selector)).toBeTruthy();
		expect(screen.getByText(label).classList.contains('sr-only')).toBe(true);
	});

	it('preserves an empty slot without announcing an unknown outcome', () => {
		const view = render(SidebarChatStatusIndicator, { status: null });
		const indicator = view.container.querySelector('[data-slot="sidebar-chat-status"]');
		expect(indicator?.getAttribute('aria-hidden')).toBe('true');
		expect(indicator?.hasAttribute('title')).toBe(false);
		expect(indicator?.childElementCount).toBe(0);
	});

	it('spins only when system and sidebar motion preferences allow it', () => {
		const source = readFileSync(
			'src/lib/components/sidebar/SidebarChatStatusIndicator.svelte',
			'utf8',
		);
		expect(source).toMatch(
			/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.sidebar-chat-status-spinner\s*\{\s*animation: sidebar-status-spin 1s linear infinite;/,
		);
		expect(source).toMatch(
			/:global\(\.sidebar-reduce-motion\) \.sidebar-chat-status-spinner\s*\{\s*animation: none;/,
		);
	});
});
