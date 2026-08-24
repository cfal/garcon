import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { CliRowMessage, ErrorMessage, TranscriptNoticeMessage } from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';

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
});
