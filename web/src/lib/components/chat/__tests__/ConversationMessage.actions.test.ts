import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';

describe('ConversationMessage actions', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders the assistant message action button as a compact overlay', () => {
		const { container } = render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', 'assistant text'),
		});

		const button = screen.getByRole('button', { name: 'More message actions' });
		expect(button.className).toContain('chat-message-action-button');
		expect(button.className).toContain('absolute');
		expect(container.querySelector('.message-menu-actions')).toBeNull();
	});

	it('renders the user message action button in the timestamp row', () => {
		const { container } = render(ConversationMessageHost, {
			message: new UserMessage('2026-06-27T00:00:00.000Z', 'user text'),
		});

		const button = screen.getByRole('button', { name: 'More message actions' });
		expect(button.className).toContain('chat-message-menu-button');
		expect(button.className).not.toContain('absolute');
		expect(container.querySelector('.message-menu-actions')).not.toBeNull();
		expect(container.querySelector('.message-menu-actions')?.className).not.toContain('opacity-0');
	});

	it('sends assistant raw text to a new session from the message menu', async () => {
		const openNewChatDialog = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', '**raw** text'),
			openNewChatDialog,
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Send to New Session' }));

		expect(openNewChatDialog).toHaveBeenCalledWith({ prefill: '**raw** text' });
	});

	it('marks the message context target open while the menu is visible', async () => {
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', 'assistant text'),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);

		await waitFor(() => {
			expect(trigger.getAttribute('data-state')).toBe('open');
		});
	});

	it('closes the message menu on the first outside touch pointerdown', async () => {
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', 'assistant text'),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);
		await waitFor(() => {
			expect(trigger.getAttribute('data-state')).toBe('open');
		});

		await fireEvent.pointerDown(document.body, { pointerType: 'touch' });

		await waitFor(() => {
			expect(trigger.getAttribute('data-state')).toBe('closed');
		});
	});

	it('opens the message menu after the shortened touch long press', async () => {
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', 'assistant text'),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.pointerDown(trigger, {
			pointerType: 'touch',
			clientX: 24,
			clientY: 36,
		});
		await new Promise((resolve) => setTimeout(resolve, 260));

		await waitFor(() => {
			expect(trigger.getAttribute('data-state')).toBe('open');
		});
	});

	it('opens the text selection dialog with assistant text fully selected', async () => {
		const text = 'hello\nworld';
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', text),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select text' }));

		const textarea = (await screen.findByRole('textbox', {
			name: 'Select text',
		})) as HTMLTextAreaElement;
		expect(textarea.className).toContain('chat-mobile-compact-textarea');
		expect(textarea.className).toContain('text-base');
		expect(textarea.className).toContain('sm:text-sm');
		await waitFor(() => {
			expect(textarea.value).toBe(text);
			expect(textarea.selectionStart).toBe(0);
			expect(textarea.selectionEnd).toBe(text.length);
		});
	});

	it('opens the text selection dialog with user text fully selected', async () => {
		const text = 'user text';
		render(ConversationMessageHost, {
			message: new UserMessage('2026-06-27T00:00:00.000Z', text),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select text' }));

		const textarea = (await screen.findByRole('textbox', {
			name: 'Select text',
		})) as HTMLTextAreaElement;
		await waitFor(() => {
			expect(textarea.value).toBe(text);
			expect(textarea.selectionStart).toBe(0);
			expect(textarea.selectionEnd).toBe(text.length);
		});
	});
});
