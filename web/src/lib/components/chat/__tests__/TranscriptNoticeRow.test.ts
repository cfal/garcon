import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptNoticeMessage } from '$shared/chat-types';
import TranscriptNoticeRow from '../rows/TranscriptNoticeRow.svelte';
import type { TicketCommandOutcome } from '$shared/garcon-ticket-result';

const AT = '2026-08-28T00:00:00.000Z';
const ticketOutcome = {
	type: 'ticket-command-outcome',
	command: 'create',
	ref: 'synthetic',
	requestViewId: '3502b645-222b-49d2-ac39-1c91f9fb1174',
	requestOrdinal: 1,
	status: 'ok',
	ticketId: 'G-2',
	revision: 1,
} satisfies TicketCommandOutcome;

describe('TranscriptNoticeRow', () => {
	it('renders a title-free ticket notice with repeatable navigation and a native new-tab href', async () => {
		const onOpenTicket = vi.fn<(id: string) => Promise<void>>().mockResolvedValue();
		const { container } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(
				AT,
				'Created ticket G-2',
				ticketOutcome,
				'Ticket command',
			),
			onOpenTicket,
		});
		expect(screen.queryByText('Ticket command')).toBeNull();
		expect(container.querySelector('[data-ticket-command]')?.textContent?.trim()).toBe(
			'Created ticket G-2',
		);
		const link = screen.getByRole('link', { name: 'G-2' });
		expect(link.getAttribute('href')).toBe('/?ticket=G-2');
		await fireEvent.click(link);
		await fireEvent.click(link);
		expect(onOpenTicket.mock.calls).toEqual([['G-2'], ['G-2']]);
		for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
			expect(await fireEvent.click(link, { [modifier]: true })).toBe(true);
		}
		expect(onOpenTicket).toHaveBeenCalledTimes(2);
	});

	it('keeps ticket references inert without workspace navigation, including shared snapshots', () => {
		render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(AT, 'Created ticket G-2', ticketOutcome),
		});
		expect(screen.getByText('G-2')).toBeTruthy();
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('renders both relationship targets and filters as literal text, not Markdown or HTML', async () => {
		const onOpenTicket = vi.fn<(id: string) => Promise<void>>().mockResolvedValue();
		const { container, rerender } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(AT, '', {
				...ticketOutcome,
				command: 'link',
				context: { link: { kind: 'blocks', targetId: 'G-7' } },
			}),
			onOpenTicket,
		});
		expect(container.textContent?.trim()).toBe('G-2 updated, added blocking link to G-7');
		await fireEvent.click(screen.getByRole('link', { name: 'G-7' }));
		expect(onOpenTicket).toHaveBeenCalledWith('G-7');
		const project = '`<script>alert(1)</script> [G-8](https://example.test)`';
		await rerender({
			message: new TranscriptNoticeMessage(AT, '', {
				type: 'ticket-command-outcome',
				command: 'list',
				status: 'ok',
				requestViewId: ticketOutcome.requestViewId,
				requestOrdinal: 2,
				context: { filters: { project, priority: 1 } },
			}),
		});
		expect([...container.querySelectorAll('code')].map((node) => node.textContent)).toEqual([
			project,
			'high',
		]);
		expect(container.querySelector('script')).toBeNull();
		expect(screen.queryByRole('link')).toBeNull();
		expect(container.textContent).toContain('Listed tickets with filters project');
	});

	it('uses error styling for failed commands and reports failed navigation without a false success', async () => {
		const onOpenTicket = vi
			.fn<(id: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('Synthetic open failure.'))
			.mockResolvedValue();
		const { container } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(AT, '', {
				...ticketOutcome,
				command: 'read',
				status: 'error',
				errorCode: 'TICKET_NOT_FOUND',
			}),
			onOpenTicket,
		});
		expect(container.querySelector('article')?.className).toContain('border-status-error-border');
		expect(container.textContent).toContain("Couldn't read ticket");
		expect(screen.getByText('TICKET_NOT_FOUND')).toBeTruthy();
		await fireEvent.click(screen.getByRole('link', { name: 'G-2' }));
		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toBe('Synthetic open failure.'),
		);
		await fireEvent.click(screen.getByRole('link', { name: 'G-2' }));
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('renders startup failures as durable error cards', () => {
		const { container } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(AT, 'Agent startup failed. The task was retained.', {
				type: 'agent-start-progress',
				phase: 'failed',
			}),
		});
		expect(screen.getByText('Agent startup failed. The task was retained.')).toBeTruthy();
		expect(container.querySelector('article')?.className).toContain('border-status-error-border');
	});
	it('links an accepted delegated start to its child before the agent produces output', () => {
		render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(AT, 'Start agent accepted.', {
				type: 'agent-start-outcome',
				ref: 'synthetic-task',
				async: true,
				requestViewId: '3502b645-222b-49d2-ac39-1c91f9fb1174',
				requestOrdinal: 1,
				status: 'accepted',
				chatId: '1234567890123456',
			}),
			resolveChatReference: () => ({ title: 'Synthetic child', isCurrent: false }),
		});

		expect(screen.getByText('Started')).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Open chat' }).getAttribute('href')).toBe(
			'/chat/1234567890123456',
		);
	});

	it('keeps a deleted child reference inert and preserves rejection details', async () => {
		const { rerender } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(AT, 'Start agent accepted.', {
				type: 'agent-start-outcome',
				ref: 'synthetic-task',
				async: true,
				requestViewId: '3502b645-222b-49d2-ac39-1c91f9fb1174',
				requestOrdinal: 1,
				status: 'accepted',
				chatId: '1234567890123456',
			}),
			resolveChatReference: () => null,
		});
		expect(screen.queryByRole('link')).toBeNull();
		expect(screen.getByText('(1234567890123456)')).toBeTruthy();
		await rerender({
			message: new TranscriptNoticeMessage(AT, 'Could not start: unknown-model.', {
				type: 'agent-start-outcome',
				ref: 'synthetic-task',
				async: true,
				requestViewId: '3502b645-222b-49d2-ac39-1c91f9fb1174',
				requestOrdinal: 1,
				status: 'rejected',
				reason: 'unknown-model',
			}),
		});
		expect(screen.getByText('Could not start: unknown-model.')).toBeTruthy();
		expect(screen.queryByText('Started')).toBeNull();
	});

	it('renders an ordered title-only preamble update notice', () => {
		const { container } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(AT, 'Preambles updated', {
				type: 'preamble-selection-changed',
				preambles: [
					{
						id: '3502b645-222b-49d2-ac39-1c91f9fb1174',
						title: 'Security constraints',
					},
					{
						id: '80becfa6-c9c7-4b31-9190-fd23c0bedf9c',
						title: 'Repository conventions',
					},
				],
			}),
		});

		expect(screen.getByText('Preambles updated')).toBeTruthy();
		expect(
			[...container.querySelectorAll('[data-slot="preamble-selection-changed-title"]')].map(
				(element) => element.textContent,
			),
		).toEqual(['Security constraints', 'Repository conventions']);
		expect(container.textContent).not.toContain('private body');
	});

	it('renders None enabled for an empty preamble update notice', () => {
		render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(AT, 'Preambles updated', {
				type: 'preamble-selection-changed',
				preambles: [],
			}),
		});

		expect(screen.getByText('None enabled')).toBeTruthy();
	});

	it('[TLV5-CHAT-ID-DISCOVERY.07-WEB-UNIT-01] renders chat ID discovery failures as error event cards', () => {
		const { container } = render(TranscriptNoticeRow, {
			message: new TranscriptNoticeMessage(
				AT,
				'Garcon could not send the chat ID to the agent.',
				{ type: 'chat-id-discovery-failure', reason: 'delivery-failed' },
				'Chat ID auto-discovery',
			),
		});

		expect(screen.getByText('Chat ID auto-discovery')).toBeTruthy();
		expect(screen.getByText(/could not send the chat ID/)).toBeTruthy();
		expect(container.querySelector('article')?.className).toContain('border-status-error-border');
	});
});
