import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { AsyncQuestionSet } from '$shared/async-user-questions';
import type { AsyncQuestionPanelPort } from '$lib/chat/conversation/async-question-context.js';
import { AsyncQuestionController } from '$lib/chat/conversation/async-question-controller.svelte.js';
import { CHAT_EVENT_CARD_SURFACE_CLASSES } from '$lib/chat/transcript/chat-event-card-style';
import AsyncQuestionMessage from '../AsyncQuestionMessage.svelte';
import AsyncQuestionMessageTestHost from './AsyncQuestionMessageTestHost.svelte';

const questions: AsyncQuestionSet = {
	id: 'questions',
	questions: [
		{ id: 'environment', prompt: 'Which environment?', allowFreeText: true, options: [{ id: 'staging', label: 'Staging' }] },
		{ id: 'deadline', prompt: 'Deadline?', allowFreeText: true, options: [] },
	],
};

afterEach(cleanup);

it('groups read-only questions in one informational card without reply controls', () => {
	render(AsyncQuestionMessage, { questions });
	const card = screen.getByRole('article');
	expect(card.getAttribute('data-slot')).toBe('chat-event-card');
	expect(card.className).toContain(CHAT_EVENT_CARD_SURFACE_CLASSES.info);
	expect(within(card).getByText('Question')).toBeTruthy();
	expect(within(card).getAllByRole('region', { name: 'Question' })).toHaveLength(2);
	for (const question of questions.questions) {
		expect(within(card).getByText(question.prompt)).toBeTruthy();
	}
	expect(within(card).queryByRole('article')).toBeNull();
	expect(within(card).queryByRole('button')).toBeNull();
});

it('keeps sending, dismissing and reopening independent within the shared card', async () => {
	const delivery = Promise.withResolvers<'steer'>();
	const send = vi.fn().mockReturnValue(delivery.promise);
	const panel = {
		controller: new AsyncQuestionController(send),
		identity: { chatId: 'chat', transcriptViewId: 'view', expectedAgentId: 'codex', expectedAgentOwnershipEpoch: 'epoch' },
		excludedResendOrdinals: [],
		canReply: () => true,
		canSubmit: () => true,
		recordedAnswer: () => undefined,
	} satisfies AsyncQuestionPanelPort;
	render(AsyncQuestionMessageTestHost, { questions, panel });
	const card = screen.getByRole('article');
	const appearance = card.className;
	const [environment, deadline] = within(card).getAllByRole('region', { name: 'Question' }).map(element => within(element));
	await fireEvent.input(deadline.getByRole('textbox'), { target: { value: 'Friday afternoon' } });
	await fireEvent.click(environment.getByRole('button', { name: 'Send answer' }));
	expect(environment.getByRole('status').textContent).toBe('Sending answer...');
	expect(deadline.queryByRole('status')).toBeNull();
	expect((deadline.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(false);

	await fireEvent.click(deadline.getByRole('button', { name: 'Dismiss question' }));
	expect(deadline.queryByRole('textbox')).toBeNull();
	expect(environment.getByRole('status').textContent).toBe('Sending answer...');
	await fireEvent.click(deadline.getByRole('button', { name: 'Reply' }));
	expect((deadline.getByRole('textbox') as HTMLInputElement).value).toBe('Friday afternoon');

	delivery.resolve('steer');
	expect(await environment.findByText('Sent to active turn')).toBeTruthy();
	expect(deadline.queryByRole('status')).toBeNull();
	await fireEvent.click(environment.getByRole('button', { name: 'Reply again' }));
	expect((environment.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(false);
	expect(environment.queryByRole('status')).toBeNull();
	expect((deadline.getByRole('textbox') as HTMLInputElement).value).toBe('Friday afternoon');
	expect(send).toHaveBeenCalledTimes(1);
	expect(screen.getByRole('article')).toBe(card);
	expect(card.className).toBe(appearance);
});
