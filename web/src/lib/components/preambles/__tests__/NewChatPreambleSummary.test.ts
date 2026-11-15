import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { PreambleSelectionProjection } from '$shared/preambles';
import NewChatPreambleSummary from '../NewChatPreambleSummary.svelte';

const emptyPreview: PreambleSelectionProjection = {
	catalogRevision: 1,
	eligiblePreambles: [],
	unavailable: [],
};

describe('NewChatPreambleSummary', () => {
	it('replaces the empty session label with selected pills and restores it when cleared', async () => {
		const onEdit = vi.fn();
		const onClear = vi.fn();
		const view = render(NewChatPreambleSummary, {
			preview: emptyPreview,
			loading: false,
			configurable: true,
			retryable: true,
			emptyLabel: 'Add preambles to session',
			onEdit,
			onClear,
			onRetry: vi.fn(),
		});
		expect(screen.getByText('Add preambles to session')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Clear preambles' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit preambles' }));
		expect(onEdit).toHaveBeenCalledOnce();

		await view.rerender({ preview: {
			...emptyPreview,
			eligiblePreambles: [{ id: 'generic-preamble', title: 'Project conventions' }],
		} });
		expect(screen.queryByText('Add preambles to session')).toBeNull();
		expect(screen.getByText('Project conventions')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Clear preambles' }));
		expect(onClear).toHaveBeenCalledOnce();
		await view.rerender({ preview: emptyPreview });
		expect(screen.getByText('Add preambles to session')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Clear preambles' })).toBeNull();
	});

	it('retains default, scheduled, loading and unavailable copy instead of replacing status with session wording', async () => {
		const view = render(NewChatPreambleSummary, {
			preview: emptyPreview,
			loading: false,
			configurable: true,
			retryable: true,
			onEdit: vi.fn(),
			onRetry: vi.fn(),
		});
		expect(screen.getByText('No preambles will be applied')).toBeTruthy();
		await view.rerender({ emptyLabel: 'Scheduled preview' });
		expect(screen.getByText('Scheduled preview')).toBeTruthy();
		await view.rerender({ readyLabel: 'Preamble preview', preview: {
			...emptyPreview, eligiblePreambles: [{ id: 'scheduled-preamble', title: 'Scheduled conventions' }],
		} });
		expect(screen.getByText('Preamble preview')).toBeTruthy();
		expect(screen.getByText('Scheduled conventions')).toBeTruthy();
		await view.rerender({ emptyLabel: 'Add preambles to session', loading: true });
		expect(screen.queryByText('Add preambles to session')).toBeNull();
		expect(screen.getByRole('status').textContent).toContain('Fetching');
		await view.rerender({ loading: false, preview: null });
		expect(screen.queryByText('Add preambles to session')).toBeNull();
		expect(screen.getByRole('alert').textContent).toContain('unavailable');
		expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
	});
});
