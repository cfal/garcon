import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	CliRowMessage,
	ThinkingMessage,
	TranscriptNoticeMessage,
	UserMessage,
} from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';
import { CollapsibleBodyLayoutHarness } from './collapsible-body-layout-harness.js';

const AT = '2026-09-05T18:00:00.000Z';
const TARGET_CHAT_ID = '1788592720180699';
const TARGET_TITLE = 'Chat links design';

describe('ConversationMessage chat links', () => {
	let collapsibleLayout: CollapsibleBodyLayoutHarness;

	beforeEach(() => {
		collapsibleLayout = new CollapsibleBodyLayoutHarness();
		collapsibleLayout.install();
	});

	afterEach(cleanup);

	it.each([
		['user', new UserMessage(AT, `Continue in ${TARGET_CHAT_ID}.`)],
		['assistant', new AssistantMessage(AT, `Continue in ${TARGET_CHAT_ID}.`)],
	])('autolinks a known bare ID in ordinary %s prose', (_label, message) => {
		render(ConversationMessageHost, {
			message,
			chatTitles: { [TARGET_CHAT_ID]: TARGET_TITLE },
		});

		expect(
			screen
				.getByRole('link', { name: `${TARGET_TITLE} (${TARGET_CHAT_ID})` })
				.getAttribute('href'),
		).toBe(`/chat/${TARGET_CHAT_ID}`);
	});

	it('keeps thinking bare IDs inert while resolving explicit chat destinations', () => {
		const { container } = render(ConversationMessageHost, {
			message: new ThinkingMessage(AT, `${TARGET_CHAT_ID} [Open target](/chat/${TARGET_CHAT_ID})`),
			chatTitles: { [TARGET_CHAT_ID]: TARGET_TITLE },
		});

		expect(screen.getByRole('link', { name: 'Open target' })).toBeTruthy();
		expect(container.querySelectorAll('[data-chat-reference-id]')).toHaveLength(1);
		expect(container.textContent).toContain(TARGET_CHAT_ID);
	});

	it.each([
		[
			'styled',
			new UserMessage(
				AT,
				`${TARGET_CHAT_ID} [Open target](/chat/${TARGET_CHAT_ID})`,
				undefined,
				undefined,
				{ origin: 'cli', style: 'info' },
			),
		],
		[
			'styleless',
			new UserMessage(
				AT,
				`${TARGET_CHAT_ID} [Open target](/chat/${TARGET_CHAT_ID})`,
				undefined,
				undefined,
				{ origin: 'cli', disclosure: 'collapsed' },
			),
		],
	] as const)('keeps %s CLI-presented user messages explicit-only', (_label, message) => {
		const { container } = render(ConversationMessageHost, {
			message,
			chatTitles: { [TARGET_CHAT_ID]: TARGET_TITLE },
		});

		expect(screen.getByRole('link', { name: 'Open target' })).toBeTruthy();
		expect(container.querySelectorAll('[data-chat-reference-id]')).toHaveLength(1);
	});

	it('keeps standalone CLI Markdown and notice Markdown explicit-only', () => {
		const content = `${TARGET_CHAT_ID} [Open target](/chat/${TARGET_CHAT_ID})`;
		const cli = render(ConversationMessageHost, {
			message: new CliRowMessage(AT, content, { style: 'info' }, 'markdown'),
			chatTitles: { [TARGET_CHAT_ID]: TARGET_TITLE },
		});
		expect(screen.getByRole('link', { name: 'Open target' })).toBeTruthy();
		expect(cli.container.querySelectorAll('[data-chat-reference-id]')).toHaveLength(1);
		cli.unmount();

		const notice = render(ConversationMessageHost, {
			message: new TranscriptNoticeMessage(AT, content, { type: 'handoff-summary' }),
			chatTitles: { [TARGET_CHAT_ID]: TARGET_TITLE },
		});
		expect(screen.getByRole('link', { name: 'Open target' })).toBeTruthy();
		expect(notice.container.querySelectorAll('[data-chat-reference-id]')).toHaveLength(1);
	});

	it.each([
		['unknown', {}, 'chat-1'],
		['current', { [TARGET_CHAT_ID]: TARGET_TITLE }, TARGET_CHAT_ID],
	] as const)('keeps a bare %s reference inert', (_label, chatTitles, selectedChatId) => {
		const { container } = render(ConversationMessageHost, {
			message: new AssistantMessage(AT, TARGET_CHAT_ID),
			chatTitles,
			selectedChatId,
		});

		expect(container.querySelector(`a[href="/chat/${TARGET_CHAT_ID}"]`)).toBeNull();
		expect(container.querySelector('[data-chat-reference-id]')?.textContent).toContain(
			TARGET_CHAT_ID,
		);
	});

	it('reacts to title updates and target deletion without reparsing authored content', async () => {
		const { container } = render(ConversationMessageHost, {
			message: new AssistantMessage(AT, TARGET_CHAT_ID),
			chatTitles: { [TARGET_CHAT_ID]: 'Original title' },
			chatTitleUpdate: { chatId: TARGET_CHAT_ID, title: 'Renamed title' },
			removableChatId: TARGET_CHAT_ID,
		});

		expect(screen.getByRole('link', { name: `Original title (${TARGET_CHAT_ID})` })).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Update chat title' }));
		await waitFor(() =>
			expect(screen.getByRole('link', { name: `Renamed title (${TARGET_CHAT_ID})` })).toBeTruthy(),
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Remove chat' }));
		await waitFor(() =>
			expect(container.querySelector(`a[href="/chat/${TARGET_CHAT_ID}"]`)).toBeNull(),
		);
		expect(container.querySelector('[data-chat-reference-id]')?.textContent).toContain(
			TARGET_CHAT_ID,
		);
	});
});
