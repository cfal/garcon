import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledPromptRunLogEntry } from '$shared/scheduled-prompts';
import ScheduledPromptRunLogDialog from '../ScheduledPromptRunLogDialog.svelte';

const now = new Date(2030, 0, 2, 12, 0, 0, 0);

function entry(overrides: Partial<ScheduledPromptRunLogEntry>): ScheduledPromptRunLogEntry {
	return {
		at: new Date(2030, 0, 2, 9, 0, 0, 0).toISOString(),
		scheduledPromptId: 'prompt-1',
		promptLabel: 'Review the build',
		outcome: 'sent',
		chatId: '123',
		message: 'Prompt sent to chat 123.',
		...overrides,
	};
}

function renderLog(entries: ScheduledPromptRunLogEntry[], onOpenChat = vi.fn()) {
	return render(ScheduledPromptRunLogDialog, {
		open: true,
		entries,
		currentTime: now,
		openableChatId: (chatId: string | null) => (chatId === '123' ? chatId : null),
		onOpenChat,
		onClose: vi.fn(),
	});
}

function entryTexts(): string[] {
	return [...document.querySelectorAll('[data-slot="scheduled-run-entry"]')].map(
		(element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
	);
}

describe('ScheduledPromptRunLogDialog', () => {
	it('lists outcomes newest first under the label each run was recorded with', () => {
		renderLog([
			entry({ at: new Date(2030, 0, 1, 9, 0, 0, 0).toISOString(), outcome: 'skipped-busy' }),
			entry({
				scheduledPromptId: 'prompt-removed',
				promptLabel: 'Rotate the keys',
				outcome: 'missed',
				chatId: null,
				message: 'Removed missed one-off prompt scheduled for 2030-01-02T08:00:00.000Z.',
			}),
			entry({
				at: new Date(2030, 0, 2, 10, 0, 0, 0).toISOString(),
				scheduledPromptId: null,
				promptLabel: null,
				outcome: 'failed',
				chatId: null,
				message: 'Prompt reconciliation failed: disk full.',
			}),
		]);

		const texts = entryTexts();
		expect(texts).toHaveLength(3);
		expect(texts[0]).toMatch(/^Failed Scheduler Prompt reconciliation failed: disk full\. Today at .+$/);
		expect(texts[1]).toMatch(/^Missed Rotate the keys Removed missed one-off prompt .+ Today at .+$/);
		expect(texts[2]).toMatch(/^Skipped, chat was busy Review the build Yesterday at .+ Open chat$/);
	});

	it('opens only chats that still exist', async () => {
		const onOpenChat = vi.fn();
		renderLog(
			[entry({ outcome: 'created-chat', chatId: '999' }), entry({ outcome: 'queued' })],
			onOpenChat,
		);

		const openButtons = screen.getAllByRole('button', { name: 'Open chat' });
		expect(openButtons).toHaveLength(1);
		await fireEvent.click(openButtons[0]);
		expect(onOpenChat).toHaveBeenCalledWith('123');
	});

	it('names a schedule action that ran without a body', () => {
		renderLog([entry({ promptLabel: '' })]);

		expect(entryTexts()[0]).toMatch(/^Sent Scheduled action Today at /);
	});

	it('explains an empty log', () => {
		renderLog([]);

		expect(screen.getByText('No scheduled prompts have run since the server started.')).toBeTruthy();
	});
});
