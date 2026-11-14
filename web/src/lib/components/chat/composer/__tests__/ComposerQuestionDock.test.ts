import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantMessage, AskUserQuestionToolUseMessage } from '$shared/chat-types';
import { AsyncQuestionController } from '$lib/chat/conversation/async-question-controller.svelte.js';
import type { AsyncQuestionPanelPort } from '$lib/chat/conversation/async-question-context.js';
import type { ComposerQuestion } from '$lib/chat/composer/composer-question.js';
import ComposerQuestionDock from '../ComposerQuestionDock.svelte';
const target = {
	chatId: 'chat',
	transcriptViewId: 'view',
	expectedAgentId: 'codex',
	expectedAgentOwnershipEpoch: 'epoch',
};
function fixture() {
	const send = vi.fn().mockResolvedValue('steer' as const);
	const controller = new AsyncQuestionController(send);
	const asyncPanel = {
		controller,
		identity: target,
		excludedResendOrdinals: [],
		canReply: () => true,
		canSubmit: () => true,
		recordedAnswer: () => undefined,
	} satisfies AsyncQuestionPanelPort;
	return {
		send,
		props: {
			identity: 'chat:view:3',
			asyncPanel,
			canAnswer: true,
			onDecision: vi.fn(),
			onSubmit: vi.fn().mockResolvedValue(true),
			onDismiss: vi.fn(),
		},
	};
}
afterEach(cleanup);
it('shows one async question at a time and advances its original count after sending', async () => {
	const { props, send } = fixture();
	const question = {
		kind: 'async',
		ordinal: 3,
		message: new AssistantMessage('2026-01-01T00:00:00Z', '', {
			id: 'set',
			questions: [
				{
					id: 'first',
					prompt: 'Which environment?',
					allowFreeText: true,
					options: [{ id: 'staging', label: 'Staging' }],
				},
				{
					id: 'second',
					prompt: 'Which release?',
					allowFreeText: true,
					options: [{ id: 'canary', label: 'Canary' }],
				},
			],
		}),
	} satisfies ComposerQuestion;
	render(ComposerQuestionDock, { ...props, question });
	expect(screen.getByText('1/2')).toBeTruthy();
	expect(screen.queryByText('Which release?')).toBeNull();
	expect(screen.queryByRole('radio')).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
	await tick();
	expect(send).toHaveBeenCalledOnce();
	expect(screen.getByText('2/2')).toBeTruthy();
	expect(screen.queryByText('Which environment?')).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Canary' }));
	await tick();
	expect(send).toHaveBeenCalledTimes(2);
});
it('resets the permission page and staged answers for a new occurrence', async () => {
	const { props } = fixture();
	const tool = new AskUserQuestionToolUseMessage('2026-01-01T00:00:00Z', 'tool', undefined, [
		{ id: 'first', prompt: 'Which environment?', options: [{ id: 'staging', label: 'Staging' }] },
		{ id: 'second', prompt: 'Which release?', options: [{ id: 'canary', label: 'Canary' }] },
	]);
	const question = {
		kind: 'permission',
		request: { permissionOccurrenceId: 'one', requestedTool: tool },
	} satisfies ComposerQuestion;
	const view = render(ComposerQuestionDock, { ...props, question });
	await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
	expect(screen.getByText('2/2')).toBeTruthy();
	await view.rerender({
		identity: 'chat:view:4',
		question: {
			kind: 'permission',
			request: { ...question.request, permissionOccurrenceId: 'two' },
		},
	});
	expect(screen.getByText('1/2')).toBeTruthy();
	expect(screen.queryByText('Which release?')).toBeNull();
	expect(props.onDecision).not.toHaveBeenCalled();
});
