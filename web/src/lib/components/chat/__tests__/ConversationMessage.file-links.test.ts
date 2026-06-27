import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';

const TS = '2026-05-14T00:00:00.000Z';

describe('ConversationMessage file links', () => {
	it('opens absolute markdown links under base but outside the chat project', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [readme](/workspace/other/README.md)'),
			openAuto,
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/current',
		});

		await fireEvent.click(screen.getByRole('link', { name: 'readme' }));

		expect(openAuto).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				fileRootPath: '/workspace',
				relativePath: 'other/README.md',
				source: 'markdown-link',
			}),
		);
	});

	it('resolves sibling relative links from the chat project under the base root', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [shared](../shared/README.md:12)'),
			openAuto,
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/current',
		});

		await fireEvent.click(screen.getByRole('link', { name: 'shared' }));

		expect(openAuto).toHaveBeenCalledWith(
			expect.objectContaining({
				fileRootPath: '/workspace',
				relativePath: 'shared/README.md',
				line: 12,
			}),
		);
	});

	it('does not open absolute markdown links outside the base path', async () => {
		const openAuto = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage(TS, 'Open [secret](/tmp/secret.md)'),
			openAuto,
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/current',
		});

		await fireEvent.click(screen.getByRole('link', { name: 'secret' }));

		expect(openAuto).not.toHaveBeenCalled();
	});
});
