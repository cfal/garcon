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
	it('uses one visual backdrop while retaining the nested interaction layer', async () => {
		render(ScheduledChatPickerDialog, {
			open: true,
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});

		await waitFor(() => {
			expect(document.querySelector('[data-slot="search-dialog-content"]')).toBeTruthy();
		});
		expect(document.querySelectorAll('.transient-backdrop')).toHaveLength(1);
		expect(document.querySelectorAll('[role="presentation"] button[tabindex="-1"]')).toHaveLength(
			1,
		);
	});
});
