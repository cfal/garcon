import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CliRowMessage,
	ErrorMessage,
	TranscriptNoticeMessage,
	UserMessage,
} from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';
import { ConversationFeedItemState } from '../ConversationFeedItemState.svelte';

const AT = '2026-08-18T12:00:00.000Z';

describe('ConversationMessage chat rows', () => {
	afterEach(() => cleanup());

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
			message: new CliRowMessage(
				AT,
				'Untitled CLI notice.',
				{ style: 'notice' },
				'plain',
			),
		});
		const untitledCard = screen.getByText('CLI notice').closest('article');
		expect(untitledCard?.className).toContain('border-status-info-border');
		expect(untitledCard?.querySelector('button')).toBeNull();

		untitled.unmount();
		render(ConversationMessageHost, {
			message: new CliRowMessage(
				AT,
				'Empty-title CLI notice.',
				{ style: 'notice' },
				'plain',
				'',
			),
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
			message: new CliRowMessage(
				AT,
				'Untitled CLI error.',
				{ style: 'error' },
				'plain',
			),
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
		const scope = container.querySelector<HTMLElement>('[style*="--cli-presentation-accent-light"]');
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
			'cli-collapsible-body-collapsed',
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
		expect(
			screen.getByText('Long CLI content').closest('.cli-collapsible-body-collapsed'),
		).toBeNull();
	});

	it('collapses styleless CLI user messages without changing the bubble style', async () => {
		const { container } = render(ConversationMessageHost, {
			message: new UserMessage(AT, 'Long user content', undefined, undefined, {
				origin: 'cli',
				disclosure: 'collapsed',
			}),
		});

		expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
		expect(container.querySelector('[data-user-message-presentation]')).toBeNull();
		expect(screen.queryByText('CLI notice')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
		expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
			'true',
		);
	});
});
