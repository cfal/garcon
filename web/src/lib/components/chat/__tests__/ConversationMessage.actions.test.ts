import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '$shared/chat-types';
import ConversationMessageHost from './ConversationMessageHost.svelte';

describe('ConversationMessage actions', () => {
	async function waitForOverlayTeardown(): Promise<void> {
		// Allows Bits UI body-scroll-lock's delayed cleanup to run before happy-dom removes document.
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	}

	afterEach(async () => {
		cleanup();
		await waitForOverlayTeardown();
	});

	it('renders the assistant message action button as a compact overlay', () => {
		const { container } = render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', 'assistant text'),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		const button = screen.getByRole('button', { name: 'More message actions' });
		expect(trigger.className).toContain('px-1.5');
		expect(trigger.className).toContain('py-1');
		expect(button.className).toContain('chat-message-action-button');
		expect(button.className).toContain('absolute');
		expect(button.parentElement?.className).toContain('min-h-8');
		expect(container.querySelector('.message-menu-actions')).toBeNull();
	});

	it('renders the user message action button in the timestamp row', () => {
		const { container } = render(ConversationMessageHost, {
			message: new UserMessage('2026-06-27T00:00:00.000Z', 'user text'),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		const button = screen.getByRole('button', { name: 'More message actions' });
		expect(trigger.className).toContain('rounded-xl');
		expect(trigger.className).toContain('border');
		expect(trigger.className).toContain('border-border');
		expect(trigger.className).toContain('px-3');
		expect(trigger.className).toContain('py-2');
		expect(trigger.className).not.toContain('rounded-2xl');
		expect(trigger.className).not.toContain('rounded-bl-md');
		expect(trigger.className).not.toContain('sm:px-4');
		expect(button.className).toContain('chat-message-menu-button');
		expect(button.className).not.toContain('absolute');
		expect(container.querySelector('.message-menu-actions')).not.toBeNull();
		expect(container.querySelector('.message-menu-actions')?.className).not.toContain('opacity-0');
	});

	it('renders tool rows synchronously without an await placeholder', () => {
		render(ConversationMessageHost, {
			message: new BashToolUseMessage('2026-06-27T00:00:00.000Z', 'tool-1', 'echo hello'),
		});

		expect(screen.getByText('echo hello')).toBeTruthy();
	});

	it('sends assistant raw text to a new session from the message menu', async () => {
		const openNewChatDialog = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', '**raw** text'),
			openNewChatDialog,
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Send to new session' }));

		expect(openNewChatDialog).toHaveBeenCalledWith({ prefill: '**raw** text' });
	});

	it('orders message menu actions and forks at the clicked message sequence', async () => {
		const onForkChat = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', 'assistant text'),
			forkUpToSeq: 9,
			onForkChat,
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);

		const labels = (await screen.findAllByRole('menuitem')).map((item) => item.textContent?.trim());
		expect(labels).toEqual(['Copy text', 'Select text', 'Fork at message', 'Send to new session']);
		const menuParts = Array.from(
			document.querySelector<HTMLElement>('[data-slot="context-menu-content"]')?.children ?? [],
		).map((item) =>
			item.getAttribute('data-slot') === 'context-menu-separator'
				? 'separator'
				: item.textContent?.trim(),
		);
		expect(menuParts).toEqual([
			'Copy text',
			'Select text',
			'separator',
			'Fork at message',
			'Send to new session',
		]);

		await fireEvent.click(screen.getByRole('menuitem', { name: 'Fork at message' }));

		expect(onForkChat).toHaveBeenCalledWith(9);
	});

	it('shows generate title from message at the bottom for durable user messages', async () => {
		const onGenerateTitleFromMessage = vi.fn();
		render(ConversationMessageHost, {
			message: new UserMessage('2026-06-27T00:00:00.000Z', 'user text'),
			forkUpToSeq: 9,
			onGenerateTitleFromMessage,
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);

		const labels = (await screen.findAllByRole('menuitem')).map((item) => item.textContent?.trim());
		expect(labels.at(-1)).toBe('Generate title from message');
		const menuParts = Array.from(
			document.querySelector<HTMLElement>('[data-slot="context-menu-content"]')?.children ?? [],
		).map((item) =>
			item.getAttribute('data-slot') === 'context-menu-separator'
				? 'separator'
				: item.textContent?.trim(),
		);
		expect(menuParts.at(-2)).toBe('separator');
		expect(menuParts.at(-1)).toBe('Generate title from message');

		await fireEvent.click(screen.getByRole('menuitem', { name: 'Generate title from message' }));

		expect(onGenerateTitleFromMessage).toHaveBeenCalledWith('user text', 9);
	});

	it('does not show generate title from message for assistant messages', async () => {
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', 'assistant text'),
			forkUpToSeq: 9,
			onGenerateTitleFromMessage: vi.fn(),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);

		expect(screen.queryByRole('menuitem', { name: 'Generate title from message' })).toBeNull();
	});

	it('does not show generate title from message for user rows without a sequence', async () => {
		render(ConversationMessageHost, {
			message: new UserMessage('2026-06-27T00:00:00.000Z', 'user text'),
			onGenerateTitleFromMessage: vi.fn(),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);

		expect(screen.queryByRole('menuitem', { name: 'Generate title from message' })).toBeNull();
	});

	it('disables message fork while keeping it visible when running fork is unsupported', async () => {
		const onForkChat = vi.fn();
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', 'assistant text'),
			forkUpToSeq: 9,
			onForkChat,
			canForkAtMessageNow: false,
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);

		const forkItem = await screen.findByRole('menuitem', { name: 'Fork at message' });
		expect(forkItem.hasAttribute('data-disabled')).toBe(true);

		await fireEvent.click(forkItem);
		expect(onForkChat).not.toHaveBeenCalled();
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

	it('lets markdown links handle touch without opening the message menu', async () => {
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', '[example](https://example.com)'),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		const link = screen.getByRole('link', { name: 'example' });
		await fireEvent.pointerDown(link, {
			pointerType: 'touch',
			clientX: 24,
			clientY: 36,
		});
		await new Promise((resolve) => setTimeout(resolve, 760));

		expect(trigger.getAttribute('data-state')).toBe('closed');
		expect(link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(
			true,
		);
	});

	it('opens the text selection dialog with assistant text in a selectable surface', async () => {
		const text = 'hello\nworld';
		window.getSelection()?.removeAllRanges();
		render(ConversationMessageHost, {
			message: new AssistantMessage('2026-06-27T00:00:00.000Z', text),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select text' }));

		const textSurface = await screen.findByRole('region', {
			name: 'Select text',
		});
		expect(textSurface.textContent).toBe(text);
		expect(textSurface.className).toContain('select-text');
		expect(textSurface.className).not.toContain('chat-mobile-compact-textarea');
		expect(window.getSelection()?.toString()).not.toBe(text);

		await fireEvent.click(screen.getByRole('button', { name: 'Select All' }));

		expect(window.getSelection()?.toString()).toBe(text);
	});

	it('opens the text selection dialog with user text in a selectable surface', async () => {
		const text = 'user text';
		render(ConversationMessageHost, {
			message: new UserMessage('2026-06-27T00:00:00.000Z', text),
		});

		const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
		await fireEvent.contextMenu(trigger);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select text' }));

		const textSurface = await screen.findByRole('region', {
			name: 'Select text',
		});
		expect(textSurface.textContent).toBe(text);
		expect(textSurface.className).toContain('select-text');
	});
});
