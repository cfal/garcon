import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuestionChoicesPanel from '../QuestionChoicesPanel.svelte';
import type {
	ResponseChoiceQuestion,
	ResponseChoiceAnswer,
} from '$lib/chat/composer/response-choices.js';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';

const question = {
	id: 'question',
	prompt: 'Which environment should be used?',
	allowMultiple: false,
	options: [
		{ id: 'staging', label: 'Staging', description: 'A test environment' },
		{ id: 'production', label: 'Production' },
	],
} satisfies ResponseChoiceQuestion;
const staging = [{ questionId: 'question', selectedOptionIds: ['staging'] }];
function fixture() {
	return {
		questions: [question],
		identity: 'chat:view:3',
		onSubmit: vi
			.fn<(answers: ResponseChoiceAnswer[]) => Promise<boolean>>()
			.mockResolvedValue(true),
		onDismiss: vi.fn(),
	};
}
async function chooseStaging(): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: 'Staging A test environment' }));
}
afterEach(cleanup);

describe('QuestionChoicesPanel', () => {
	it('shows the selection mode and count without sending or choosing on arrival', async () => {
		const props = fixture();
		const { container } = render(QuestionChoicesPanel, props);
		expect(screen.getByRole('region', { name: 'Question - Select one answer' })).toBeTruthy();
		expect(screen.getByRole('group', { name: question.prompt })).toBeTruthy();
		expect(screen.getByText('1/1')).toBeTruthy();
		expect(screen.queryByRole('radio')).toBeNull();
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Write my own answer' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
		await fireEvent.submit(container.querySelector('form')!);
		expect(props.onSubmit).not.toHaveBeenCalled();
	});
	it('sends one selection immediately and prevents subsequent sends', async () => {
		const props = fixture();
		const { container } = render(QuestionChoicesPanel, props);
		await chooseStaging();
		await tick();
		expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(staging);
		expect(
			screen
				.getByRole('button', { name: 'Staging A test environment' })
				.getAttribute('aria-pressed'),
		).toBe('true');
		await chooseStaging();
		await fireEvent.submit(container.querySelector('form')!);
		expect(props.onSubmit).toHaveBeenCalledOnce();
	});
	it('toggles multiple answers and submits all selected IDs in display order', async () => {
		const props = fixture();
		render(QuestionChoicesPanel, { ...props, questions: [{ ...question, allowMultiple: true }] });
		expect(screen.getByText('Question - Select multiple answers')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Production' }));
		await chooseStaging();
		await chooseStaging();
		expect(
			screen
				.getByRole('button', { name: 'Staging A test environment' })
				.getAttribute('aria-pressed'),
		).toBe('false');
		await chooseStaging();
		expect(props.onSubmit).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
		expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith([
			{ questionId: 'question', selectedOptionIds: ['staging', 'production'] },
		]);
	});
	it('advances single questions and confirms multiple questions before sending one set', async () => {
		const props = fixture();
		render(QuestionChoicesPanel, {
			...props,
			questions: [
				question,
				{ ...question, id: 'second', prompt: 'Which targets?', allowMultiple: true },
			],
		});
		expect(screen.getByText('1/2')).toBeTruthy();
		await chooseStaging();
		expect(props.onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText('2/2')).toBeTruthy();
		expect(screen.queryByText(question.prompt)).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Production' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
		expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith([
			...staging,
			{ questionId: 'second', selectedOptionIds: ['production'] },
		]);
	});
	it('uses the same gate for cards and native form submission', async () => {
		const props = fixture();
		const view = render(QuestionChoicesPanel, { ...props, disabled: true });
		await chooseStaging();
		await fireEvent.submit(view.container.querySelector('form')!);
		expect(props.onSubmit).not.toHaveBeenCalled();
	});
	it('prevents duplicate sends and dismissal during delivery', async () => {
		const props = fixture();
		const delivery = Promise.withResolvers<boolean>();
		props.onSubmit.mockReturnValue(delivery.promise);
		const { container } = render(QuestionChoicesPanel, props);
		await chooseStaging();
		expect(container.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
		await chooseStaging();
		await fireEvent.submit(container.querySelector('form')!);
		await fireEvent.click(screen.getByRole('button', { name: 'Dismiss question' }));
		expect(props.onSubmit).toHaveBeenCalledOnce();
		expect(props.onDismiss).not.toHaveBeenCalled();
		delivery.resolve(true);
		await delivery.promise;
	});
	it('retries a rejected single answer by clicking the same card', async () => {
		const props = fixture();
		props.onSubmit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		render(QuestionChoicesPanel, props);
		await chooseStaging();
		await tick();
		expect(screen.getByRole('alert').textContent).toBe('Answer could not be sent');
		await chooseStaging();
		expect(props.onSubmit).toHaveBeenCalledTimes(2);
	});
	it.each([new Error('The executor is unavailable'), 'unstructured failure'])(
		'reports failure while retaining the selection: %s',
		async (failure) => {
			const props = fixture();
			props.onSubmit.mockRejectedValue(failure);
			render(QuestionChoicesPanel, props);
			await chooseStaging();
			await tick();
			expect(screen.getByRole('alert').textContent).toBe(
				failure instanceof Error ? failure.message : 'Answer could not be sent',
			);
			expect(
				screen
					.getByRole('button', { name: 'Staging A test environment' })
					.getAttribute('aria-pressed'),
			).toBe('true');
		},
	);
	it('resets staged selections and errors on identity changes', async () => {
		const props = fixture();
		props.onSubmit.mockResolvedValue(false);
		const view = render(QuestionChoicesPanel, props);
		await chooseStaging();
		await tick();
		await view.rerender({ identity: 'other-chat:view:3' });
		expect(screen.queryByRole('alert')).toBeNull();
		expect(
			screen
				.getByRole('button', { name: 'Staging A test environment' })
				.getAttribute('aria-pressed'),
		).toBe('false');
	});
	it('blocks another send after unknown outcome but permits dismissal', async () => {
		const props = fixture();
		props.onSubmit.mockRejectedValueOnce(new CommandOutcomeUnknownError());
		const view = render(QuestionChoicesPanel, props);
		await chooseStaging();
		await tick();
		expect(screen.getByRole('alert').textContent).toContain('Delivery unconfirmed');
		await chooseStaging();
		await fireEvent.submit(view.container.querySelector('form')!);
		expect(props.onSubmit).toHaveBeenCalledOnce();
		await fireEvent.click(screen.getByRole('button', { name: 'Dismiss question' }));
		expect(props.onDismiss).toHaveBeenCalledOnce();
	});
	it.each(['success', 'failure'])('ignores late %s after switching identities', async (outcome) => {
		const props = fixture();
		const delivery = Promise.withResolvers<boolean>();
		props.onSubmit.mockReturnValueOnce(delivery.promise).mockResolvedValueOnce(true);
		const view = render(QuestionChoicesPanel, props);
		await chooseStaging();
		await view.rerender({ identity: 'other-chat:view:3' });
		await fireEvent.click(screen.getByRole('button', { name: 'Production' }));
		if (outcome === 'success') delivery.resolve(true);
		else delivery.reject(new Error('Old request failed'));
		await delivery.promise.catch(() => undefined);
		await tick();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(props.onSubmit).toHaveBeenLastCalledWith([
			{ questionId: 'question', selectedOptionIds: ['production'] },
		]);
		expect(props.onSubmit).toHaveBeenCalledTimes(2);
	});
	it('does not settle a newer send when the older send finishes', async () => {
		const props = fixture();
		const first = Promise.withResolvers<boolean>();
		const second = Promise.withResolvers<boolean>();
		props.onSubmit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const view = render(QuestionChoicesPanel, props);
		await chooseStaging();
		await view.rerender({ identity: 'other-chat:view:3' });
		await fireEvent.click(screen.getByRole('button', { name: 'Production' }));
		first.resolve(false);
		await first.promise;
		await tick();
		expect(view.container.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
		await fireEvent.submit(view.container.querySelector('form')!);
		expect(props.onSubmit).toHaveBeenCalledTimes(2);
		second.resolve(false);
		await second.promise;
		await tick();
		expect(screen.getByRole('alert').textContent).toBe('Answer could not be sent');
	});
	it('discards late failure after switching away and back', async () => {
		const props = fixture();
		const delivery = Promise.withResolvers<boolean>();
		props.onSubmit.mockReturnValueOnce(delivery.promise);
		const view = render(QuestionChoicesPanel, props);
		await chooseStaging();
		await view.rerender({ identity: 'other-chat:view:3' });
		await view.rerender({ identity: props.identity });
		delivery.reject(new Error('Old attempt failed'));
		await delivery.promise.catch(() => undefined);
		await tick();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(
			screen
				.getByRole('button', { name: 'Staging A test environment' })
				.getAttribute('aria-pressed'),
		).toBe('false');
	});
	it('renders untrusted markup as text', () => {
		const { container } = render(QuestionChoicesPanel, {
			...fixture(),
			questions: [
				{
					id: 'unsafe',
					prompt: '<script>window.bad = true</script>',
					allowMultiple: false,
					options: [
						{ id: 'html', label: '<img src=x onerror=bad()>', description: '<b>Text only</b>' },
					],
				},
			],
		});
		expect(screen.getByText('<script>window.bad = true</script>')).toBeTruthy();
		expect(container.querySelector('script, img, b')).toBeNull();
	});
	it('retains existing focus and bounds the scrollable panel', async () => {
		const existingInput = document.createElement('textarea');
		document.body.append(existingInput);
		existingInput.focus();
		const { container } = render(QuestionChoicesPanel, fixture());
		await tick();
		expect(document.activeElement).toBe(existingInput);
		expect(container.querySelector('[data-question-choices-panel]')?.className).toContain(
			'max-h-[min(50dvh,28rem)]',
		);
		expect(container.querySelector('.overflow-y-auto')).toBeTruthy();
		existingInput.remove();
	});
});
