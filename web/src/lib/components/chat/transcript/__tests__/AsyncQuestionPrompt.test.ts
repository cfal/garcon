import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import AsyncQuestionPrompt from '../AsyncQuestionPrompt.svelte';
import { AsyncQuestionController, asyncQuestionDraftKey } from '$lib/chat/conversation/async-question-controller.svelte.js';
import type { AsyncQuestionPanelPort } from '$lib/chat/conversation/async-question-context.js';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';
import type { AsyncQuestionPrompt as Prompt } from '$shared/async-user-questions';

const question: Prompt = { id: 'q1', prompt: 'Which environment?', allowFreeText: true, options: [{ id: 'o1', label: 'Staging' }, { id: 'o2', label: 'Production' }] };
const target = { chatId: 'chat', transcriptViewId: 'view', expectedAgentId: 'codex', expectedAgentOwnershipEpoch: 'epoch' };
const key = asyncQuestionDraftKey(target, 3, question.id);

function fixture() {
	const send = vi.fn().mockResolvedValue('steer' as const);
	const controller = new AsyncQuestionController(send);
	const panel = { controller, identity: target, canReply: (): boolean => true, canSubmit: (): boolean => true, recordedAnswer: () => undefined } satisfies AsyncQuestionPanelPort;
	return { send, controller, panel };
}

afterEach(cleanup);

it('preselects but never auto-submits and sends one independent answer', async () => {
	const { panel, send } = fixture();
	render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	expect((screen.getByRole('radio', { name: 'Staging' }) as HTMLInputElement).checked).toBe(true);
	expect(send).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
	await tick();
	expect(send).toHaveBeenCalledWith(target, { questionId: 'q1', question: question.prompt, answer: 'Staging', source: { chatId: 'chat', transcriptViewId: 'view', ordinal: 3 } });
	expect(screen.getByText('Sent to active turn')).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Reply again' })).toBeTruthy();
});

it('keeps text drafts across virtualization and isolates chat identities', async () => {
	const { panel, controller } = fixture();
	const first = render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	await fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
	await fireEvent.input(screen.getByRole('textbox', { name: question.prompt }), { target: { value: '  Custom\nchoice  ' } });
	const draft = controller.get(key)?.draft;
	first.unmount();
	render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	expect(controller.get(key)?.draft).toEqual(draft);
	expect((screen.getByRole('textbox', { name: question.prompt }) as HTMLInputElement).value).toContain('Custom');
	expect(controller.get(asyncQuestionDraftKey({ ...target, chatId: 'other-chat' }, 3, question.id))).toBeUndefined();
});

it('uses the same readiness gate for click and form submission', async () => {
	const { panel, send } = fixture();
	panel.canSubmit = () => false;
	const { container } = render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true);
	await fireEvent.submit(container.querySelector('form')!);
	expect(send).not.toHaveBeenCalled();
});

it('retains a failed draft and reports uncertainty without another send', async () => {
	const { panel, send, controller } = fixture();
	send.mockRejectedValue(new CommandOutcomeUnknownError());
	controller.edit(key, target, { selectedQuestionOptions: {}, questionTextAnswers: { q1: 'Exact draft' } });
	render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	await fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
	await tick();
	expect(screen.getByText(/Delivery unconfirmed/)).toBeTruthy();
	expect(controller.get(key)?.draft?.questionTextAnswers?.q1).toBe('Exact draft');
	expect(send).toHaveBeenCalledTimes(1);
});

it('renders shares and prior owners without reply controls', () => {
	const { panel } = fixture();
	panel.canReply = () => false;
	render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	render(AsyncQuestionPrompt, { question });
	expect(screen.queryByRole('button')).toBeNull();
	expect(screen.getAllByText(question.prompt)).toHaveLength(2);
});

it('bounds draft retention and prunes replaced views and deleted chats', () => {
	const { controller } = fixture();
	for (let ordinal = 1; ordinal <= 210; ordinal++) {
		controller.edit(asyncQuestionDraftKey(target, ordinal, 'q1'), target, { selectedQuestionOptions: {} });
	}
	expect(controller.get(asyncQuestionDraftKey(target, 1, 'q1'))).toBeUndefined();
	expect(controller.get(asyncQuestionDraftKey(target, 210, 'q1'))).toBeDefined();
	controller.retainView('chat', 'replacement');
	expect(controller.get(asyncQuestionDraftKey(target, 210, 'q1'))).toBeUndefined();
	controller.edit(key, target, { selectedQuestionOptions: {} });
	controller.prune(new Set());
	expect(controller.get(key)).toBeUndefined();
});
