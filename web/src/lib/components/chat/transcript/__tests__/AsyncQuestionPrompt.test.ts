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
	const panel = { controller, identity: target, excludedResendOrdinals: [2], canReply: (): boolean => true, canSubmit: (): boolean => true, recordedAnswer: () => undefined } satisfies AsyncQuestionPanelPort;
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
	expect(send).toHaveBeenCalledWith(target, { questionId: 'q1', question: question.prompt, answer: 'Staging', source: { chatId: 'chat', transcriptViewId: 'view', ordinal: 3 } }, [2]);
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

it('dismisses and reopens a question without losing its draft or sending input', async () => {
	const { panel, controller, send } = fixture();
	controller.edit(key, target, { selectedQuestionOptions: {}, questionTextAnswers: { q1: 'Custom answer' } });
	render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	await fireEvent.click(screen.getByRole('button', { name: 'Dismiss question' }));
	expect(screen.queryByRole('textbox')).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
	expect((screen.getByRole('textbox', { name: question.prompt }) as HTMLInputElement).value).toBe('Custom answer');
	expect(send).not.toHaveBeenCalled();
});

it.each([
	[new Error('Definite failure'), 'Definite failure'],
	['non-error rejection', 'Answer could not be sent'],
])('retains drafts on definite failures: %s', async (failure, message) => {
	const { panel, controller, send } = fixture();
	send.mockRejectedValue(failure);
	controller.edit(key, target, { selectedQuestionOptions: {}, questionTextAnswers: { q1: 'Custom answer' } });
	render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	await fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
	await tick();
	expect(controller.get(key)).toMatchObject({ status: 'failed', message, draft: { questionTextAnswers: { q1: 'Custom answer' } } });
	expect(send).toHaveBeenCalledTimes(1);
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

it.each(['success', 'failure'])('does not restore a pruned draft after late %s', async outcome => {
	const { controller, send } = fixture();
	const delivery = Promise.withResolvers<'steer'>();
	send.mockReturnValue(delivery.promise);
	const pending = controller.submit(target, 3, question, 'Staging');
	controller.retainView(target.chatId, 'replacement');
	if (outcome === 'success') delivery.resolve('steer');
	else delivery.reject(new Error('Late failure'));
	await pending;
	expect(controller.get(key)).toBeUndefined();
});

it.each(['success', 'failure'])('does not overwrite a replacement draft after late %s', async outcome => {
	const { controller, send } = fixture();
	const delivery = Promise.withResolvers<'steer'>();
	send.mockReturnValue(delivery.promise);
	const pending = controller.submit(target, 3, question, 'Staging');
	controller.retainView(target.chatId, 'replacement');
	const draft = { selectedQuestionOptions: {}, questionTextAnswers: { q1: 'New draft' } };
	controller.edit(key, target, draft);
	if (outcome === 'success') delivery.resolve('steer');
	else delivery.reject(new Error('Late failure'));
	await pending;
	expect(controller.get(key)).toStrictEqual({ target, draft });
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

it('retains the sending fence under draft eviction pressure', async () => {
	const { controller, send } = fixture();
	const delivery = Promise.withResolvers<'steer'>();
	send.mockReturnValue(delivery.promise);
	const pending = controller.submit(target, 3, question, 'Staging');
	for (let ordinal = 4; ordinal <= 204; ordinal++) {
		controller.edit(asyncQuestionDraftKey(target, ordinal, 'q1'), target, { selectedQuestionOptions: {} });
	}
	expect(controller.get(key)?.status).toBe('sending');
	controller.edit(key, target, { selectedQuestionOptions: {} });
	controller.dismiss(key, target, { selectedQuestionOptions: {} });
	expect(controller.get(key)?.status).toBe('sending');
	void controller.submit(target, 3, question, 'Staging');
	expect(send).toHaveBeenCalledTimes(1);
	delivery.resolve('steer');
	await pending;
	expect(controller.get(key)?.status).toBe('sent');
});

it('bounds in-flight retention and reopens admission when a pending answer settles', async () => {
	const { controller, send, panel } = fixture();
	const delivery = Promise.withResolvers<'steer'>();
	send.mockReturnValue(delivery.promise);
	const pending = Array.from({ length: 200 }, (_, index) => controller.submit(target, index + 4, question, 'Staging'));
	render(AsyncQuestionPrompt, { question, ordinal: 3, panel });
	expect(controller.canRetain(key)).toBe(false);
	expect(screen.getByText(/Waiting for pending answers/)).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
	controller.edit(key, target, { selectedQuestionOptions: {} });
	await controller.submit(target, 3, question, 'Staging');
	expect(controller.get(key)).toBeUndefined();
	expect(send).toHaveBeenCalledTimes(200);
	delivery.resolve('steer');
	await Promise.all(pending);
	await tick();
	expect(controller.canRetain(key)).toBe(true);
	await fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
	expect(send).toHaveBeenCalledTimes(201);
});
