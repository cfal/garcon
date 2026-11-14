import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import Host from './ComposerStructuredQuestionHost.svelte';
import type { AskUserQuestionPrompt } from '$shared/chat-types';
const single: AskUserQuestionPrompt = {
	id: 'first',
	prompt: 'Which environment?',
	options: [
		{ id: 'staging', label: 'Staging' },
		{ id: 'production', label: 'Production' },
	],
};
afterEach(cleanup);
it('stages a single answer, toggles multiple choices, and submits one complete response', async () => {
	const onSubmit = vi.fn();
	render(Host, {
		questions: [single, { ...single, id: 'second', prompt: 'Which targets?', allowMultiple: true }],
		onSubmit,
	});
	expect(screen.getByText('1/2')).toBeTruthy();
	expect(screen.queryByRole('radio')).toBeNull();
	expect(screen.queryByRole('button', { name: 'Submit answer' })).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
	expect(screen.getByText('2/2')).toBeTruthy();
	expect(screen.getByText('Question - Select multiple answers')).toBeTruthy();
	expect(onSubmit).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Production' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
	expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
		{ questionId: 'first', selectedOptionIds: ['staging'] },
		{ questionId: 'second', selectedOptionIds: ['production'] },
	]);
});
it('submits a lone single-answer question on click and obeys executor readiness', async () => {
	const onSubmit = vi.fn();
	const view = render(Host, { questions: [single], canAnswer: false, onSubmit });
	await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
	await fireEvent.submit(view.container.querySelector('form')!);
	expect(onSubmit).not.toHaveBeenCalled();
	await view.rerender({ canAnswer: true });
	await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
	expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
		{ questionId: 'first', selectedOptionIds: ['staging'] },
	]);
});

it('accepts a custom structured answer without a separate custom-answer action', async () => {
	const onSubmit = vi.fn();
	const view = render(Host, { questions: [{ ...single, allowFreeText: true }], onSubmit });
	await fireEvent.input(screen.getByRole('textbox', { name: single.prompt }), { target: { value: 'Custom environment' } });
	await fireEvent.submit(view.container.querySelector('form')!);
	expect(onSubmit).toHaveBeenCalledExactlyOnceWith([{ questionId: single.id, selectedOptionIds: [], text: 'Custom environment' }]);
});

it('includes an optional note entered before a single option confirms the answer', async () => {
	const onSubmit = vi.fn();
	render(Host, { questions: [{ ...single, allowFreeText: true, allowNotes: true }], onSubmit });
	await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Synthetic selection note' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
	expect(onSubmit).toHaveBeenCalledExactlyOnceWith([{ questionId: single.id, selectedOptionIds: ['staging'], text: 'Synthetic selection note' }]);
});
