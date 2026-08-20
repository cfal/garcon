import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorMessage, TranscriptNoticeMessage } from '$shared/chat-types';
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

	it('renders titled and untitled CLI notices with fixed provenance and no disclosure action', () => {
		const titled = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(
				AT,
				'Synthetic CLI notice.\nSecond line.',
				{ type: 'cli-row', title: 'Deployment' },
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
		render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, 'Untitled CLI notice.', { type: 'cli-row' }),
		});
		const untitledCard = screen.getByText('CLI notice').closest('article');
		expect(untitledCard?.className).toContain('border-status-info-border');
		expect(untitledCard?.querySelector('button')).toBeNull();
	});

	it('renders titled and untitled CLI errors without the provider-error header', () => {
		const titled = render(ConversationMessageHost, {
			message: new ErrorMessage(
				AT,
				'Synthetic CLI error.',
				{ type: 'cli-row', title: 'Release validation' },
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
			message: new ErrorMessage(AT, 'Untitled CLI error.', { type: 'cli-row' }),
		});
		const untitledCard = screen.getByText('CLI error').closest('article');
		expect(untitledCard?.className).toContain('border-status-error-border');
		expect(screen.queryByText('Error')).toBeNull();
	});
});
