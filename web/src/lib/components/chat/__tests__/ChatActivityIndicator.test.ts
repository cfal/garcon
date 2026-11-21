import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChatActivityIndicator from '../ChatActivityIndicator.svelte';

describe('ChatActivityIndicator', () => {
	it.each([
		['working', 'Chat is processing', '.chat-processing-spinner'],
		['error', 'Chat error', '.bg-sidebar-chat-error'],
		['pending-user-action', 'Pending user action', '.text-status-warning'],
	] as const)('renders the %s indicator with an accessible label', (status, label, selector) => {
		render(ChatActivityIndicator, { status });
		const indicator = screen.getByTitle(label);
		expect(indicator.dataset.status).toBe(status);
		expect(indicator.querySelector(selector)?.getAttribute('aria-hidden')).toBe('true');
		expect(screen.getByText(label).classList.contains('sr-only')).toBe(true);
	});
});
