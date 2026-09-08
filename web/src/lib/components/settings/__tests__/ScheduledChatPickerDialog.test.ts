import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

const testContext = vi.hoisted(() => ({
	sessions: {
		orderedChats: [],
		quietRefreshChats: vi.fn(async () => undefined),
	},
}));

vi.mock('$lib/context', () => ({
	getChatSessions: () => testContext.sessions,
	getOptionalTransientLayers: () => null,
}));

const ScheduledChatPickerDialog = (await import('../ScheduledChatPickerDialog.svelte')).default;

describe('ScheduledChatPickerDialog', () => {
	it('renders the shared search panel inside one primary dialog', async () => {
		render(ScheduledChatPickerDialog, {
			open: true,
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		await waitFor(() => {
			expect(document.querySelector('[data-slot="search-dialog-panel"]')).toBeTruthy();
		});
		expect(document.querySelectorAll('.transient-backdrop')).toHaveLength(1);
		expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(1);
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		expect(
			document.querySelector('[data-slot="search-dialog-results"]')?.textContent,
		).not.toContain('Load more');
		expect(document.body.textContent).not.toContain('Best match');
	});
});
