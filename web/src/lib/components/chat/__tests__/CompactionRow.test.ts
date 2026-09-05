import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { CompactionMessage } from '$shared/chat-types';
import CompactionRow from '../CompactionRow.svelte';

const TS = '2026-05-14T00:00:00.000Z';

describe('CompactionRow', () => {
	it('renders the trigger label and token reduction', () => {
		render(CompactionRow, {
			message: new CompactionMessage(TS, 'manual', 'Built a todo app', 29611, 3903),
		});

		expect(screen.getByText('Context compacted')).toBeTruthy();
		expect(screen.getByText('(manual)')).toBeTruthy();
		expect(screen.getByText('29,611 → 3,903 tokens')).toBeTruthy();
	});

	it('keeps the summary collapsed until expanded', async () => {
		render(CompactionRow, {
			message: new CompactionMessage(TS, 'auto', 'Decided on Postgres', 100, 20),
		});

		expect(screen.getByText('(auto)')).toBeTruthy();
		expect(screen.queryByText('Decided on Postgres')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Show summary' }));

		expect(screen.getByText('Decided on Postgres')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Hide summary' })).toBeTruthy();
	});

	it('omits the token label when counts are unavailable', () => {
		render(CompactionRow, {
			message: new CompactionMessage(TS, 'manual', 'summary'),
		});

		expect(screen.queryByText(/tokens/)).toBeNull();
	});

	it('supports caller-owned disclosure state for virtual remounts', async () => {
		const onOpenChange = vi.fn();
		render(CompactionRow, {
			message: new CompactionMessage(TS, 'manual', 'Persisted summary'),
			open: true,
			onOpenChange,
		});

		expect(screen.getByText('Persisted summary')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Hide summary' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('resolves explicit chat links without autolinking bare IDs in summaries', () => {
		const chatId = '1788592720180699';
		const { container } = render(CompactionRow, {
			message: new CompactionMessage(
				TS,
				'manual',
				`${chatId} [Open target](/chat/${chatId})`,
			),
			open: true,
			resolveChatReference: () => ({ title: 'Target chat', isCurrent: false }),
		});

		expect(screen.getByRole('link', { name: 'Open target' })).toBeTruthy();
		expect(container.querySelectorAll('[data-chat-reference-id]')).toHaveLength(1);
	});
});
