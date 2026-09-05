import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CliRowMessage,
	ErrorMessage,
	TranscriptNoticeMessage,
	UserMessage,
} from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';
import { CollapsibleBodyLayoutHarness } from './collapsible-body-layout-harness.js';
import { ConversationFeedItemState } from '../ConversationFeedItemState.svelte';

const AT = '2026-08-18T12:00:00.000Z';
const SOURCE_CHAT_ID = '1788090107980900';
const TARGET_CHAT_ID = '1788090107980901';
const SECOND_TARGET_CHAT_ID = '1788090107980902';

function handoffNotice(): TranscriptNoticeMessage {
	return new TranscriptNoticeMessage(
		AT,
		'## Current objective\n\nPreserve **typed provenance**.',
		{ type: 'handoff-summary' },
		'Handoff summary',
	);
}

describe('ConversationMessage chat rows', () => {
	let collapsibleLayout: CollapsibleBodyLayoutHarness;

	beforeEach(() => {
		collapsibleLayout = new CollapsibleBodyLayoutHarness();
		collapsibleLayout.install();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('keeps internal notices on the generic information-card path', () => {
		const { container } = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Synthetic notice.\nSecond line.'),
		});

		const card = container.querySelector('article');
		expect(card?.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
			'Synthetic notice.\nSecond line.',
		);
		expect(card?.className).toContain('border-status-info-border');
		expect(card?.querySelector('button')).toBeNull();
	});

	it('renders uncompacted carryover as a plain titled notice', () => {
		const { container } = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(
				AT,
				'Earlier chat history was small enough to carry over as context.',
				undefined,
				'History carried without compaction',
			),
		});

		const card = screen.getByText('History carried without compaction').closest('article');
		expect(card?.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
			'Earlier chat history was small enough to carry over as context.',
		);
		expect(card?.querySelector('button')).toBeNull();
		expect(container.querySelector('.markdown-body')).toBeNull();
	});

	it('renders handoff summaries as Markdown behind a body collapsed by default', () => {
		const { container } = render(ConversationMessageHost, { message: handoffNotice() });

		const button = screen.getByRole('button', { name: 'Show more' });
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(document.getElementById(button.getAttribute('aria-controls')!)?.classList).toContain(
			'collapsible-body-collapsed',
		);
		const card = screen.getByText('Handoff summary').closest('article');
		expect(card?.querySelector('h2')?.textContent).toBe('Current objective');
		expect(card?.querySelector('strong')?.textContent).toBe('typed provenance');
		expect(container.querySelector('.markdown-body')).toBeTruthy();
	});

	it('keeps handoff summaries collapsed when CLI messages are always expanded', () => {
		render(ConversationMessageHost, {
			message: handoffNotice(),
			alwaysExpandCliMessages: true,
		});

		expect(screen.getByRole('button', { name: 'Show more' }).getAttribute('aria-expanded')).toBe(
			'false',
		);
	});

	it('expands a collapsed handoff summary through Show more', async () => {
		render(ConversationMessageHost, { message: handoffNotice() });

		await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});

	it('preserves handoff summary expansion across remounts through the feed disclosure state', async () => {
		const itemState = new ConversationFeedItemState();
		const disclosureState = itemState.disclosurePort('notice-row-1');
		const message = handoffNotice();
		const first = render(ConversationMessageHost, { message, disclosureState });

		await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
		first.unmount();

		render(ConversationMessageHost, { message, disclosureState });
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});

	it('expands a collapsed handoff summary before focus can remain clipped', async () => {
		render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(
				AT,
				'[Focused link](https://example.com)',
				{ type: 'handoff-summary' },
				'Handoff summary',
			),
		});

		await fireEvent.focusIn(screen.getByRole('link', { name: 'Focused link' }));
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});

	it('renders short received inter-agent messages without a redundant disclosure', () => {
		collapsibleLayout.contentHeight = 96;
		const { container } = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(
				AT,
				'Review the **typed contract**.\n\n- Keep the IDs\n- Resolve the title',
				{ type: 'inter-agent-message-received', fromChatId: SOURCE_CHAT_ID },
				`Message from chat ${SOURCE_CHAT_ID}`,
			),
			chatTitles: { [SOURCE_CHAT_ID]: 'Protocol review' },
		});

		const row = container.querySelector('[data-inter-agent-message-direction="received"]');
		const card = row?.querySelector('article');
		expect(screen.getByText('Received Message').className).toContain('text-xs');
		expect(screen.getByText('From')).toBeTruthy();
		expect(screen.getByText('Protocol review')).toBeTruthy();
		expect(screen.getByText(`(${SOURCE_CHAT_ID})`)).toBeTruthy();
		const participant = screen.getByRole('link', {
			name: `Protocol review (${SOURCE_CHAT_ID})`,
		});
		expect(participant.getAttribute('href')).toBe(`/chat/${SOURCE_CHAT_ID}`);
		expect(participant.getAttribute('title')).toBe(`Protocol review (${SOURCE_CHAT_ID})`);
		expect(participant.className).toContain('text-primary');
		expect(participant.className).toContain('hover:underline');
		expect(participant.className).toContain('items-center');
		expect(screen.getByText('typed contract').tagName).toBe('STRONG');
		expect(card?.className).toContain('border-status-neutral-border');
		expect(card?.className).not.toContain('border-status-info-border');
		expect(card?.parentElement?.className).toContain('sm:max-w-[85%]');
		expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
	});

	it('renders short sent inter-agent messages with titles and no redundant disclosure', () => {
		collapsibleLayout.contentHeight = 48;
		const { container } = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(
				AT,
				'Please apply the `focused fix`.',
				{
					type: 'inter-agent-message-outcome',
					results: [{ chatId: TARGET_CHAT_ID, status: 'queued' }],
				},
				'Inter-agent message',
			),
			chatTitles: { [TARGET_CHAT_ID]: 'Parser cleanup' },
		});

		expect(screen.getByText('Sent Message').className).toContain('text-xs');
		expect(screen.getByText('To')).toBeTruthy();
		expect(screen.getByText('Parser cleanup')).toBeTruthy();
		expect(screen.getByText(`(${TARGET_CHAT_ID})`)).toBeTruthy();
		expect(
			screen.getByRole('link', { name: `Parser cleanup (${TARGET_CHAT_ID})` }).getAttribute(
				'href',
			),
		).toBe(`/chat/${TARGET_CHAT_ID}`);
		expect(screen.getByRole('img', { name: 'Sent' })).toBeTruthy();
		expect(screen.getByText('focused fix').tagName).toBe('CODE');
		expect(container.querySelector('.markdown-body')).toBeTruthy();
		expect(container.textContent).not.toContain('Queued:');
		expect(container.textContent).not.toContain('pending delivery');
		expect(container.querySelector('article')?.className).toContain('border-status-neutral-border');
		expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
	});

	it('lists each target and marks only failed deliveries', () => {
		const mixed = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Mixed delivery body.', {
				type: 'inter-agent-message-outcome',
				results: [
					{ chatId: TARGET_CHAT_ID, status: 'delivered' },
					{ chatId: SECOND_TARGET_CHAT_ID, status: 'failed', reason: 'target-not-found' },
				],
			}),
			chatTitles: {
				[TARGET_CHAT_ID]: 'Build verification',
				[SECOND_TARGET_CHAT_ID]: 'Release coordinator',
			},
		});

		expect(screen.getByText('Sent Message')).toBeTruthy();
		const participantLabel = screen.getByText('To');
		const participantList = participantLabel.nextElementSibling;
		expect(participantLabel.parentElement?.className).toContain(
			'grid-cols-[auto_minmax(0,1fr)]',
		);
		expect(participantList?.tagName).toBe('UL');
		expect(participantList?.querySelectorAll('li')).toHaveLength(2);
		const deliveredRecipient = screen.getByText('Build verification').closest('li');
		const failedRecipient = screen.getByText('Release coordinator').closest('li');
		expect(deliveredRecipient?.textContent).toContain(`(${TARGET_CHAT_ID})`);
		expect(deliveredRecipient?.querySelector('[role="img"][aria-label="Sent"]')).toBeTruthy();
		expect(deliveredRecipient?.querySelector('[aria-label="Send failed"]')).toBeNull();
		expect(failedRecipient?.textContent).toContain(`(${SECOND_TARGET_CHAT_ID})`);
		expect(failedRecipient?.querySelector('[role="img"][aria-label="Send failed"]')).toBeTruthy();
		expect(failedRecipient?.querySelector('[aria-label="Sent"]')).toBeNull();
		mixed.unmount();

		const failed = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Failed delivery body.', {
				type: 'inter-agent-message-outcome',
				results: [{ chatId: TARGET_CHAT_ID, status: 'failed', reason: 'disabled' }],
			}),
		});
		expect(screen.getByText('Sent Message')).toBeTruthy();
		expect(
			screen.getByText(TARGET_CHAT_ID).closest('li')?.querySelector('[aria-label="Send failed"]'),
		).toBeTruthy();
		failed.unmount();

		render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Anonymous **message**.', {
				type: 'inter-agent-message-received',
				fromChatId: null,
			}),
		});
		expect(screen.getByText('Received Message')).toBeTruthy();
		expect(screen.getByText('From')).toBeTruthy();
		expect(screen.getByText('Hidden sender')).toBeTruthy();
		expect(screen.getByText('Hidden sender').getAttribute('title')).toBe('Hidden sender');
		expect(screen.getByText('message').tagName).toBe('STRONG');
	});

	it('hides the server-authored audit prefix on durable legacy outcomes', () => {
		const { container } = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(
				AT,
				`Queued: ${TARGET_CHAT_ID} (pending delivery is not retained across server restart)\n\nLegacy **body**.`,
				{
					type: 'inter-agent-message-outcome',
					results: [{ chatId: TARGET_CHAT_ID, status: 'queued' }],
				},
			),
		});

		expect(container.textContent).not.toContain('pending delivery');
		expect(screen.getByText('body').tagName).toBe('STRONG');
	});

	it('reactively updates an inter-agent title when the chat title changes', async () => {
		render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Reactive title body.', {
				type: 'inter-agent-message-received',
				fromChatId: SOURCE_CHAT_ID,
			}),
			chatTitles: { [SOURCE_CHAT_ID]: 'Original title' },
			chatTitleUpdate: { chatId: SOURCE_CHAT_ID, title: 'Renamed title' },
		});

		expect(screen.getByText('Original title')).toBeTruthy();
		expect(screen.getByRole('link', { name: `Original title (${SOURCE_CHAT_ID})` })).toBeTruthy();
		expect(screen.getByText(`(${SOURCE_CHAT_ID})`)).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Update chat title' }));
		await waitFor(() => expect(screen.getByText('Renamed title')).toBeTruthy());
		expect(screen.getByRole('link', { name: `Renamed title (${SOURCE_CHAT_ID})` })).toBeTruthy();
		expect(screen.getByText(`(${SOURCE_CHAT_ID})`)).toBeTruthy();
	});

	it('keeps a current-chat participant inert with its full truncation tooltip', () => {
		const { container } = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Self reference.', {
				type: 'inter-agent-message-received',
				fromChatId: SOURCE_CHAT_ID,
			}),
			chatTitles: { [SOURCE_CHAT_ID]: 'Current chat' },
			selectedChatId: SOURCE_CHAT_ID,
		});

		const participant = container.querySelector(
			`[data-chat-reference-id="${SOURCE_CHAT_ID}"]`,
		);
		expect(participant?.tagName).toBe('SPAN');
		expect(participant?.getAttribute('title')).toBe(`Current chat (${SOURCE_CHAT_ID})`);
		expect(participant?.className).not.toContain('text-primary');
	});

	it('runs the message divider to the padded card edges', () => {
		const { container } = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Divider body.', {
				type: 'inter-agent-message-outcome',
				results: [{ chatId: TARGET_CHAT_ID, status: 'delivered' }],
			}),
		});

		const divider = container.querySelector('.inter-agent-message-divider');
		expect(divider?.className).toContain('-mx-3');
		expect(divider?.className).toContain('border-t');
	});

	it('keeps provider errors on the generic error path', () => {
		render(ConversationMessageHost, {
			message: new ErrorMessage(AT, 'Synthetic error.'),
		});

		const card = screen.getByText('Synthetic error.').closest('article');
		expect(card?.className).toContain('border-status-error-border');
		expect(screen.getByText('Error')).toBeTruthy();
	});

	it('renders CLI info rows with the neutral treatment', () => {
		render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'Synthetic CLI information.',
				{ style: 'info' },
				'plain',
				'Consultation status',
			),
		});

		const card = screen.getByText('Consultation status').closest('article');
		expect(card?.className).toContain('cli-row-message-info');
		expect(card?.className).toContain('border-status-neutral-border');
		expect(screen.getByText('CLI info').className).toContain('sr-only');
	});

	it('renders titled and untitled CLI notices with fixed provenance and no disclosure action', () => {
		const titled = render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'Synthetic CLI notice.\nSecond line.',
				{ style: 'notice' },
				'plain',
				'Deployment',
			),
		});

		const card = screen.getByText('Deployment').closest('article');
		expect(card?.className).toContain('cli-row-message');
		expect(card?.className).toContain('border-status-info-border');
		expect(screen.getByText('CLI notice').className).toContain('sr-only');
		expect(card?.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
			'Synthetic CLI notice.\nSecond line.',
		);
		expect(card?.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
		expect(card?.querySelector('button')).toBeNull();
		expect(titled.container.textContent).not.toContain('Error');

		titled.unmount();
		const untitled = render(ConversationMessageHost, {
			message: new CliRowMessage(AT, 'Untitled CLI notice.', { style: 'notice' }, 'plain'),
		});
		const untitledCard = screen.getByText('CLI notice').closest('article');
		expect(untitledCard?.className).toContain('border-status-info-border');
		expect(untitledCard?.querySelector('button')).toBeNull();

		untitled.unmount();
		render(ConversationMessageHost, {
			message: new CliRowMessage(AT, 'Empty-title CLI notice.', { style: 'notice' }, 'plain', ''),
		});
		expect(screen.getByText('CLI notice').closest('article')).toBeTruthy();
	});

	it('renders titled and untitled CLI errors without the provider-error header', () => {
		const titled = render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'Synthetic CLI error.',
				{ style: 'error' },
				'plain',
				'Release validation',
			),
		});

		const titledCard = screen.getByText('Release validation').closest('article');
		expect(titledCard?.className).toContain('cli-row-message');
		expect(titledCard?.className).toContain('border-status-error-border');
		expect(screen.getByText('CLI error').className).toContain('sr-only');
		expect(screen.queryByText('Error')).toBeNull();
		expect(titledCard?.querySelector('button')).toBeNull();

		titled.unmount();
		render(ConversationMessageHost, {
			message: new CliRowMessage(AT, 'Untitled CLI error.', { style: 'error' }, 'plain'),
		});
		const untitledCard = screen.getByText('CLI error').closest('article');
		expect(untitledCard?.className).toContain('border-status-error-border');
		expect(screen.queryByText('Error')).toBeNull();
	});

	it('renders Markdown and custom theme accents without changing preset rows', () => {
		const { container } = render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'**Deployment complete.**',
				{
					style: 'custom',
					customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
				},
				'markdown',
				'Deployment',
			),
		});

		const card = screen.getByText('Deployment').closest('article');
		expect(card?.className).toContain('cli-presentation-custom');
		expect(screen.getByText('Deployment complete.').tagName).toBe('STRONG');
		const scope = container.querySelector<HTMLElement>(
			'[style*="--cli-presentation-accent-light"]',
		);
		expect(scope?.style.getPropertyValue('--cli-presentation-accent-light')).toBe('#7c3aed');
		expect(scope?.style.getPropertyValue('--cli-presentation-accent-dark')).toBe('#c4b5fd');
	});

	it('renders preset Markdown with inherited color and preserved line breaks', () => {
		const { container } = render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'**Deployment complete.**\nVerification passed.',
				{ style: 'notice' },
				'markdown',
				'Deployment',
			),
		});

		const markdown = container.querySelector('.markdown-body');
		expect(markdown?.className).toContain('text-inherit');
		expect(markdown?.className).not.toContain('text-foreground');
		expect(screen.getByText('Deployment complete.').tagName).toBe('STRONG');
		expect(markdown?.querySelector('br')).toBeTruthy();
	});

	it('collapses opted-in CLI rows and expands them locally', async () => {
		render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'Long CLI content',
				{ style: 'notice' },
				'plain',
				undefined,
				'collapsed',
			),
		});

		const button = screen.getByRole('button', { name: 'Show more' });
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(button.classList).toContain('min-h-6');
		expect(document.getElementById(button.getAttribute('aria-controls')!)?.classList).toContain(
			'collapsible-body-collapsed',
		);
		await fireEvent.click(button);
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});

	it('preserves CLI row expansion across remounts through the feed disclosure state', async () => {
		const itemState = new ConversationFeedItemState();
		const disclosureState = itemState.disclosurePort('cli-row-1');
		const message = new CliRowMessage(
			AT,
			'Long CLI content',
			{ style: 'notice' },
			'plain',
			undefined,
			'collapsed',
		);
		const first = render(ConversationMessageHost, { message, disclosureState });

		await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
		first.unmount();

		render(ConversationMessageHost, { message, disclosureState });
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});

	it('expands a collapsed CLI body before focus can remain inside clipped content', async () => {
		render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'[Focused link](https://example.com)',
				{ style: 'info' },
				'markdown',
				undefined,
				'collapsed',
			),
		});

		await fireEvent.focusIn(screen.getByRole('link', { name: 'Focused link' }));
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});

	it('forces CLI rows expanded when the dedicated preference is enabled', () => {
		render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'Long CLI content',
				{ style: 'error' },
				'plain',
				undefined,
				'collapsed',
			),
			alwaysExpandCliMessages: true,
		});

		expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
		expect(screen.getByText('Long CLI content').closest('.collapsible-body-collapsed')).toBeNull();
	});

	it('collapses overflowing ordinary user messages automatically', async () => {
		collapsibleLayout.contentHeight = 320;
		const { container } = render(ConversationMessageHost, {
			message: new UserMessage(AT, '## Long user prompt\n\nPreserve **all details**.'),
		});

		const button = screen.getByRole('button', { name: 'Show more' });
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(document.getElementById(button.getAttribute('aria-controls')!)?.classList).toContain(
			'collapsible-body-collapsed',
		);
		expect(document.getElementById(button.getAttribute('aria-controls')!)?.classList).toContain(
			'collapsible-body-tall',
		);
		expect(container.querySelector('[data-user-message-presentation]')).toBeNull();
		expect(screen.getByText('Long user prompt').tagName).toBe('H2');
		expect(screen.getByText('all details').tagName).toBe('STRONG');

		await fireEvent.click(button);
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});

	it('leaves short ordinary user messages without a disclosure', async () => {
		collapsibleLayout.contentHeight = 80;
		const { container } = render(ConversationMessageHost, {
			message: new UserMessage(AT, 'Short user prompt'),
		});

		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
			expect(container.querySelector('.collapsible-body-truncated')).toBeNull();
		});
	});

	it('keeps ordinary user messages collapsed when CLI messages are always expanded', () => {
		collapsibleLayout.contentHeight = 320;
		render(ConversationMessageHost, {
			message: new UserMessage(AT, 'Long ordinary user prompt'),
			alwaysExpandCliMessages: true,
		});

		expect(screen.getByRole('button', { name: 'Show more' }).getAttribute('aria-expanded')).toBe(
			'false',
		);
	});

	it('preserves ordinary user expansion across remounts', async () => {
		collapsibleLayout.contentHeight = 320;
		const itemState = new ConversationFeedItemState();
		const disclosureState = itemState.disclosurePort('user-row-1');
		const message = new UserMessage(AT, 'Long ordinary user prompt');
		const first = render(ConversationMessageHost, { message, disclosureState });

		await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
		first.unmount();

		render(ConversationMessageHost, { message, disclosureState });
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});

	it('keeps styled CLI user messages expanded unless they opt into collapse', () => {
		const { container } = render(ConversationMessageHost, {
			message: new UserMessage(AT, 'Long presented user prompt', undefined, undefined, {
				origin: 'cli',
				style: 'info',
			}),
		});

		expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
		expect(container.querySelector('.collapsible-body-collapsed')).toBeNull();
		expect(container.querySelector('.collapsible-body-tall')).toBeNull();
	});

	it('collapses styleless CLI user messages without changing the bubble style', async () => {
		collapsibleLayout.contentHeight = 320;
		const { container } = render(ConversationMessageHost, {
			message: new UserMessage(AT, 'Long user content', undefined, undefined, {
				origin: 'cli',
				disclosure: 'collapsed',
			}),
		});

		expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
		expect(container.querySelector('.collapsible-body-tall')).toBeTruthy();
		expect(container.querySelector('[data-user-message-presentation]')).toBeNull();
		expect(screen.queryByText('CLI notice')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});
});
