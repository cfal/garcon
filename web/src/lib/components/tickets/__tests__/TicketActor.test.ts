import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { TicketActor as Actor } from '$shared/tickets';
import TicketActor from '../TicketActor.svelte';

afterEach(cleanup);

const chatId = '1000000000000001';
it('renders a missing executor by its durable identity without human or observed attribution', () => {
	const executorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
	render(TicketActor, { actor: { kind: 'executor', executorId, declaredChatId: null }, chats: [], username: 'local', onOpenChat: vi.fn() });
	expect(screen.getByText(executorId)).toBeTruthy();
	expect(screen.queryByText('You')).toBeNull();
});
it.each([
	{ kind: 'chat', chatId, provenance: 'observed' },
	{ kind: 'user', username: 'local', principalMode: 'local', declaredChatId: chatId },
	{ kind: 'executor', executorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', declaredChatId: chatId },
] satisfies Actor[])('opens the %j actor chat without source navigation', async (actor) => {
	const onOpenChat = vi.fn();
	const props = {
		actor,
		chats: [{ id: chatId, title: 'Synthetic actor chat' }],
		username: 'local',
		onOpenChat,
	};
	const view = render(TicketActor, props);
	await fireEvent.click(screen.getByRole('button', { name: 'Synthetic actor chat …0001' }));
	if (actor.kind === 'user') expect(view.container.textContent).toContain('You');
	expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(chatId);
	await view.rerender({ ...props, chats: [] });
	expect(screen.queryByRole('button')).toBeNull();
	expect(screen.getByText(`Deleted chat · ${chatId}`)).toBeTruthy();
});
