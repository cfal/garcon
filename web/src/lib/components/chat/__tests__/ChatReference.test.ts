import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatReferenceTestHost from './ChatReferenceTestHost.svelte';

const CHAT_ID = '1788592720180699';

describe('ChatReference', () => {
	afterEach(cleanup);

	it('renders a known non-current chat as a semantic anchor with title and ID', () => {
		render(ChatReferenceTestHost, {
			chatId: CHAT_ID,
			resolution: { title: 'Chat links design', isCurrent: false },
			linkClass: 'text-primary hover:underline',
		});

		const link = screen.getByRole('link', { name: `Chat links design (${CHAT_ID})` });
		expect(link.getAttribute('href')).toBe(`/chat/${CHAT_ID}`);
		expect(link.getAttribute('title')).toBe(`Chat links design (${CHAT_ID})`);
		expect(link.className).toContain('text-primary');
		expect(link.className).toContain('focus-visible:ring-2');
	});

	it.each([
		['unknown', null],
		['current', { title: 'Current chat', isCurrent: true }],
	] as const)('renders an %s reference as inert text', (_label, resolution) => {
		const { container } = render(ChatReferenceTestHost, { chatId: CHAT_ID, resolution });

		expect(container.querySelector('a')).toBeNull();
		expect(container.querySelector('[data-chat-reference-id]')?.textContent).toContain(CHAT_ID);
	});

	it('does not duplicate a missing title or add a redundant inert tooltip', () => {
		const { container } = render(ChatReferenceTestHost, { chatId: CHAT_ID, resolution: null });
		const reference = container.querySelector('[data-chat-reference-id]');

		expect(reference?.textContent).toBe(CHAT_ID);
		expect(reference?.getAttribute('title')).toBeNull();
	});

	it('preserves full inert tooltips for truncating participant references', () => {
		const { container } = render(ChatReferenceTestHost, {
			chatId: CHAT_ID,
			resolution: { title: 'Current chat', isCurrent: true },
			inertTooltipPolicy: 'always',
		});

		expect(container.querySelector('[data-chat-reference-id]')?.getAttribute('title')).toBe(
			`Current chat (${CHAT_ID})`,
		);
	});

	it('preserves a structured custom label and authored title for a known chat', () => {
		render(ChatReferenceTestHost, {
			chatId: CHAT_ID,
			resolution: { title: 'Live title', isCurrent: false },
			authoredLabelText: 'Custom label',
			authoredTitle: 'Authored title',
			customLabel: true,
		});

		const link = screen.getByRole('link', { name: 'Custom label' });
		expect(link.querySelector('strong')?.textContent).toBe('Custom label');
		expect(link.getAttribute('title')).toBe('Authored title');
		expect(link.textContent).not.toContain(CHAT_ID);
	});

	it('appends the durable ID to an unresolved custom label', () => {
		const { container } = render(ChatReferenceTestHost, {
			chatId: CHAT_ID,
			resolution: null,
			authoredLabelText: 'Custom label',
			customLabel: true,
		});

		expect(container.querySelector('a')).toBeNull();
		expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe(
			`Custom label (${CHAT_ID})`,
		);
	});

	it('leaves primary, modified, and auxiliary activation uncancelled', () => {
		render(ChatReferenceTestHost, {
			chatId: CHAT_ID,
			resolution: { title: null, isCurrent: false },
		});
		const link = screen.getByRole('link', { name: CHAT_ID });
		const events = [
			new MouseEvent('click', { bubbles: true, cancelable: true }),
			new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
			new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
			new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
		];

		for (const event of events) {
			link.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
	});

	it('keeps pointer and context-menu gestures from reaching the message surface', async () => {
		const onParentPointerDown = vi.fn();
		const onParentContextMenu = vi.fn();
		render(ChatReferenceTestHost, {
			chatId: CHAT_ID,
			resolution: { title: null, isCurrent: false },
			onParentPointerDown,
			onParentContextMenu,
		});
		const link = screen.getByRole('link', { name: CHAT_ID });

		await fireEvent.pointerDown(link);
		await fireEvent.contextMenu(link);

		expect(onParentPointerDown).not.toHaveBeenCalled();
		expect(onParentContextMenu).not.toHaveBeenCalled();
	});
});
